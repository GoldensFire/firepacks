// Вход через Discord и всё, что к нему прилагается: сессии, оценки, чёрный список.
// То же самое, что src/auth.js делает дома, с двумя вынужденными отличиями.
//
// Первое: вместо node:crypto — тот crypto, что есть у браузера и у Workers.
// Хеш там асинхронный, случайные байты берутся иначе, base64url приходится
// доделывать руками. Считается при этом ровно то же: sha256 от ключа сессии.
//
// Второе: ключи приложения приходят не из файлов в data, а из секретов
// Cloudflare (npx wrangler secret put). В код и в конфиг они не попадают.

import { settings } from '../../src/settings.js';
import { buildAuthorKey } from '../../src/keys.js';

const DISCORD_API = 'https://discord.com/api/v10';
const AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';

// Прав просим два: identify даёт имя и аватар, email — не саму почту, а признак
// того, что она в Discord подтверждена. Без подтверждённой почты вход не
// состоится: пустой аккаунт заводится за минуту, и десяток таких накрутил бы
// паку любую оценку. Подробности — в заголовке src/auth.js.
const SCOPE = 'identify email';

/** Отказ, ради которого всё и затевалось. Текст один на оба отказа — и когда
    почта не подтверждена, и когда Discord о ней вовсе промолчал. */
const EMAIL_NOT_VERIFIED = 'Для входа необходимо подтвердить адрес электронной почты в Discord.';

export const SESSION_COOKIE = 'firepacks_session';
const STATE_COOKIE = 'firepacks_state';

/** Заведён ли вход вообще. Без ключей приложения сайт работает как раньше. */
export function hasDiscord(env) {
	return Boolean(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET);
}

/**
 * Адрес возврата. Discord сверяет его с точностью до символа.
 *
 * Дома он считается от PUBLIC_URL, потому что заголовку Host верить нельзя:
 * его подставляет клиент. Здесь Host подставляет не клиент, а Cloudflare —
 * по нему запрос и попал на этот Worker, — поэтому адрес берётся из запроса,
 * и настраивать ничего не нужно. PUBLIC_URL всё же остался: он пригодится,
 * когда у сайта появится своё имя, а старое на workers.dev откроют по привычке.
 */
export function redirectUri(env, url) {
	const base = (env.PUBLIC_URL ?? '').replace(/\/+$/, '') || new URL(url).origin;
	return `${base}/auth/discord/callback`;
}

async function hashToken(token) {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
	return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Случайная строка в base64url: btoa такого не умеет, поэтому доводится руками. */
function randomToken(bytes) {
	const buffer = new Uint8Array(bytes);
	crypto.getRandomValues(buffer);

	return btoa(String.fromCharCode(...buffer))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}

function parseCookies(request) {
	const out = {};

	for (const part of (request.headers.get('cookie') ?? '').split(';')) {
		const eq = part.indexOf('=');

		if (eq > 0) {
			out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
		}
	}

	return out;
}

/**
 * Кука входа. HttpOnly — чтобы её не достал скрипт со страницы; SameSite=Lax —
 * чтобы она не уезжала на чужие сайты, но переживала возврат из Discord
 * (Strict её на возврате не пришлёт, и вход не состоится).
 *
 * Secure здесь безусловный, в отличие от дома: у Cloudflare нет адреса без https,
 * а на localhost этот файл не работает вовсе.
 */
function cookieHeader(name, value, maxAgeSeconds) {
	return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${maxAgeSeconds}`;
}

const DAY = 24 * 60 * 60 * 1000;

/** Кто прислал запрос, или null. Заодно изредка подчищает истёкшие сессии. */
export async function currentUser(db, request) {
	const token = parseCookies(request)[SESSION_COOKIE];

	if (!token) {
		return null;
	}

	// Раз в сотню обращений выметаем просроченное: отдельного будильника ради
	// одной таблицы заводить не за чем.
	if (Math.random() < 0.01) {
		await db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(Date.now()).run();
	}

	const now = Date.now();
	const hash = await hashToken(token);

	const row = await db.prepare(`
		SELECT u.id, u.discord_id, u.username, u.global_name, u.avatar, s.expires_at
		FROM sessions s JOIN users u ON u.id = s.user_id
		WHERE s.token_hash = ? AND s.expires_at > ?
	`).bind(hash, now).first();

	if (!row) {
		return null;
	}

	// Пришёл — значит, сайтом пользуются, и конец сессии отодвигается. Двигается
	// срок в базе, а не кука: куку без ответа не переставить, а каким именно
	// ответом закончится этот запрос, здесь ещё не известно. Поэтому кука выдана
	// сразу надолго (cookieDays), а настоящий срок хранится тут.
	//
	// Реже, чем раз в sessionRenewDays, база не трогается: у D1 каждая запись —
	// расход по тарифу, а открытий страницы за день бывает много.
	const fresh = now + settings.sessionDays * DAY;

	if (row.expires_at < fresh - settings.sessionRenewDays * DAY) {
		await db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').bind(fresh, hash).run();
	}

	return {
		id: row.id,
		discordId: row.discord_id,
		name: row.global_name || row.username,
		avatar: row.avatar
			? `https://cdn.discordapp.com/avatars/${row.discord_id}/${row.avatar}.png?size=64`
			: null,
	};
}

/** Шаг первый: отправляем человека в Discord, запомнив одноразовый state. */
export function startLogin(env, url) {
	const state = randomToken(24);

	const query = new URLSearchParams({
		client_id: env.DISCORD_CLIENT_ID,
		redirect_uri: redirectUri(env, url),
		response_type: 'code',
		scope: SCOPE,
		state,
		// prompt здесь не указан нарочно. С prompt=none Discord обещает провести
		// человека молча, но только того, кто уже разрешил приложению доступ:
		// всем остальным — а это ровно те, кто входит впервые, — он вместо входа
		// возвращает error=consent_required.
	});

	return new Response(null, {
		status: 302,
		headers: {
			// State живёт в куке, а не в памяти сервера: сравнение куки с тем, что
			// вернул Discord, и есть защита от чужой ссылки «войдите вот сюда».
			// Здесь у этого есть и вторая причина: памяти, общей для всех запросов,
			// у Worker попросту нет — соседний запрос уходит в соседний изолят.
			'Set-Cookie': cookieHeader(STATE_COOKIE, state, 600),
			Location: `${AUTHORIZE_URL}?${query}`,
		},
	});
}

/**
 * Шаг второй: Discord вернул человека с кодом. Меняем код на токен, спрашиваем,
 * кто это, заводим сессию. Токен Discord после этого не нужен и не сохраняется:
 * сайт больше ничего от его имени не делает.
 */
export async function finishLogin(db, env, request, url) {
	const state = parseCookies(request)[STATE_COOKIE];
	const code = url.searchParams.get('code');

	const fail = message => new Response(null, {
		status: 302,
		headers: {
			'Set-Cookie': cookieHeader(STATE_COOKIE, '', 0),
			Location: `/?login=${encodeURIComponent(message)}`,
		},
	});

	// Discord отказал сам — например, человек закрыл окно согласия. Его пояснение
	// куда полезнее нашего «что-то пошло не так», поэтому оно и уходит на страницу.
	const refused = url.searchParams.get('error');

	if (refused) {
		const details = url.searchParams.get('error_description') || refused;
		return fail(refused === 'access_denied'
			? 'Вход отменён: Discord не получил разрешения'
			: `Discord отказал в входе: ${details}`);
	}

	if (!code || !state || state !== url.searchParams.get('state')) {
		return fail('Вход не состоялся: запрос пришёл не отсюда или устарел');
	}

	const back = redirectUri(env, url);

	let tokenResponse;

	try {
		tokenResponse = await fetch(`${DISCORD_API}/oauth2/token`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				client_id: env.DISCORD_CLIENT_ID,
				client_secret: env.DISCORD_CLIENT_SECRET,
				grant_type: 'authorization_code',
				code,
				redirect_uri: back,
			}),
		});
	} catch (error) {
		// Discord недоступен. Раньше такое вылетало наружу пятисотой страницей —
		// а это не поломка сайта, и попытку имеет смысл повторить.
		console.error(`Discord не ответил на запрос токена: ${error.message}`);
		return fail('Discord не отвечает. Попробуйте войти ещё раз через минуту');
	}

	if (!tokenResponse.ok) {
		// Почти всегда это несовпадение адреса возврата: Discord сверяет его
		// с точностью до символа, а вписать его в настройки приложения легко забыть.
		const reason = await tokenResponse.text().catch(() => '');
		console.error(`Discord не отдал токен (${tokenResponse.status}): ${reason}`);
		console.error(`Адрес возврата, который отправил сайт: ${back}`);

		return fail(`Discord отказал в входе. Проверьте, что адрес возврата в настройках приложения совпадает с ${back}`);
	}

	const { access_token: accessToken } = await tokenResponse.json().catch(() => ({}));

	if (!accessToken) {
		console.error('Discord ответил на запрос токена без access_token');
		return fail('Discord не отдал ключ доступа. Попробуйте войти ещё раз');
	}

	let meResponse;

	try {
		meResponse = await fetch(`${DISCORD_API}/users/@me`, {
			headers: { Authorization: `Bearer ${accessToken}` },
		});
	} catch (error) {
		console.error(`Discord не ответил на запрос профиля: ${error.message}`);
		return fail('Discord не отвечает. Попробуйте войти ещё раз через минуту');
	}

	if (!meResponse.ok) {
		return fail('Не удалось прочитать профиль Discord');
	}

	const me = await meResponse.json().catch(() => null);

	// Номер аккаунта — то единственное, чем человек в базе и опознаётся. Приходит
	// он строкой, но приводится к ней явно: дальше он идёт в запросы, а не в текст,
	// и что именно окажется в ответе, решает не сайт.
	const discordId = String(me?.id ?? '');

	if (!discordId) {
		console.error('Discord отдал профиль без id');
		return fail('Не удалось прочитать профиль Discord');
	}

	// ————— главная преграда накрутке —————
	//
	// Признак берётся из ответа Discord здесь, в Worker, и только отсюда: со
	// страницы его не подменить, потому что страница его и не касается.
	//
	// verified !== true, а не === false: если прав email не дали или Discord
	// поля не прислал вовсе, признака нет, а «нет признака» — это не «почта
	// подтверждена». Пускать в таком случае значило бы обходить проверку,
	// просто убрав из ответа поле.
	if (me.verified !== true) {
		// Отказ распространяется и на тех, кто вошёл до этой проверки: пока
		// у аккаунта не подтверждена почта, ни одной живой сессии у него быть
		// не должно, а не только новой. Чужих сессий это не трогает — сносятся
		// строки ровно того аккаунта, которому сейчас отказали.
		await db.prepare(
			'DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE discord_id = ?)',
		).bind(discordId).run();

		return fail(EMAIL_NOT_VERIFIED);
	}

	const now = Date.now();

	const user = await db.prepare(`
		INSERT INTO users (discord_id, username, global_name, avatar, created_at, seen_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT (discord_id) DO UPDATE SET
			username = excluded.username,
			global_name = excluded.global_name,
			avatar = excluded.avatar,
			seen_at = excluded.seen_at
		RETURNING id
	`).bind(discordId, me.username ?? '', me.global_name ?? null, me.avatar ?? null, now, now).first();

	const token = randomToken(32);

	await db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
		.bind(await hashToken(token), user.id, now, now + settings.sessionDays * DAY).run();

	const headers = new Headers({ Location: '/' });
	// Кука надолго, настоящий срок — в базе, и его отодвигают посещения
	// (см. currentUser): иначе сайт выкидывал бы того, кто заходит каждый день
	headers.append('Set-Cookie', cookieHeader(SESSION_COOKIE, token, settings.cookieDays * 24 * 60 * 60));
	headers.append('Set-Cookie', cookieHeader(STATE_COOKIE, '', 0));

	return new Response(null, { status: 302, headers });
}

export async function logout(db, request) {
	const token = parseCookies(request)[SESSION_COOKIE];

	if (token) {
		await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await hashToken(token)).run();
	}

	return new Response('{"ok":true}', {
		headers: {
			'Set-Cookie': cookieHeader(SESSION_COOKIE, '', 0),
			'Content-Type': 'application/json; charset=utf-8',
		},
	});
}

/**
 * Ставит оценку от 1 до 10 (полшага звезды — один балл) или снимает её,
 * если score = 0. Возвращает то, что показать на карточке.
 */
export async function rate(db, packKeyValue, userId, score) {
	const value = Math.round(Number(score));

	if (value === 0) {
		await db.prepare('DELETE FROM ratings WHERE pack_key = ? AND user_id = ?')
			.bind(packKeyValue, userId).run();
	} else if (Number.isFinite(value) && value >= 1 && value <= 10) {
		await db.prepare(`
			INSERT INTO ratings (pack_key, user_id, score, rated_at) VALUES (?, ?, ?, ?)
			ON CONFLICT (pack_key, user_id) DO UPDATE SET score = excluded.score, rated_at = excluded.rated_at
		`).bind(packKeyValue, userId, value, Date.now()).run();
	} else {
		throw new Error('Оценка должна быть от 1 до 10 или 0, чтобы её снять');
	}

	const row = await db.prepare('SELECT COUNT(*) AS count, AVG(score) AS average FROM ratings WHERE pack_key = ?')
		.bind(packKeyValue).first();

	return {
		mine: value === 0 ? null : value,
		count: row.count,
		// Средний балл до порога наружу не отдаём вовсе: спрятать его на странице
		// мало — число всё равно уехало бы в браузер и нашлось бы в ответе API.
		average: row.count >= settings.minRatingsForScore ? Math.round(row.average * 10) / 10 : null,
	};
}

/**
 * Прячет от человека автора или пак. Автор хранится тем же ключом, каким сайт
 * ищет паки по автору (buildAuthorKey), пак — общим ключом всех своих копий.
 */
export async function setBlacklisted(db, userId, kind, value, label, blacklisted) {
	if (kind !== 'author' && kind !== 'pack') {
		throw new Error('В чёрный список попадают только авторы и паки');
	}

	const key = kind === 'author' ? buildAuthorKey(String(value ?? '')) : String(value ?? '').trim();

	if (!key) {
		throw new Error('Нечего добавлять в чёрный список');
	}

	if (blacklisted) {
		await db.prepare('INSERT OR REPLACE INTO blacklist (user_id, kind, value, label, added_at) VALUES (?, ?, ?, ?, ?)')
			.bind(userId, kind, key, String(label ?? '').slice(0, 200), Date.now()).run();
	} else {
		await db.prepare('DELETE FROM blacklist WHERE user_id = ? AND kind = ? AND value = ?')
			.bind(userId, kind, key).run();
	}

	return { kind, value: key, blacklisted: Boolean(blacklisted) };
}

export async function listBlacklist(db, userId) {
	if (!userId) {
		return [];
	}

	const { results } = await db.prepare(
		'SELECT kind, value, label, added_at FROM blacklist WHERE user_id = ? ORDER BY added_at DESC',
	).bind(userId).all();

	return results.map(row => ({
		kind: row.kind,
		value: row.value,
		label: row.label || row.value,
		addedAt: row.added_at,
	}));
}
