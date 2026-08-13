// Вход через Discord и всё, что к нему прилагается: сессии, оценки, чёрный список.
//
// Почему именно Discord: паки живут в обсуждении ВК, а играют в них в голосовых
// каналах, и второй регистрации ради оценки никто заводить не станет. Своих
// паролей сайт при этом не хранит вовсе — хранить нечего, а значит и терять.
//
// Схема самая обычная (authorization code), безо всяких библиотек: два запроса
// к Discord и кука с ключом сессии. Прав просим ровно одно — identify: сайту
// нужны имя и аватар, и ни почта, ни список серверов ему не нужны.

import crypto from 'node:crypto';
import { config } from './config.js';
import { db, buildAuthorKey } from './db.js';

const DISCORD_API = 'https://discord.com/api/v10';
const AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';

/** Заведён ли вход вообще. Без ключей приложения сайт работает как раньше. */
export function hasDiscord() {
	return Boolean(config.discordClientId && config.discordClientSecret);
}

/**
 * Адрес возврата. Discord сверяет его с точностью до символа, поэтому он
 * считается от PUBLIC_URL, а не от заголовка Host: заголовок подставляет клиент,
 * и доверять ему в том, куда отправлять человека с кодом входа, не стоит.
 */
export function redirectUri() {
	const base = config.publicUrl || `http://localhost:${config.port}`;
	return `${base}/auth/discord/callback`;
}

// ————— сессии —————

const SESSION_COOKIE = 'firepacks_session';
const STATE_COOKIE = 'firepacks_state';

const hashToken = token => crypto.createHash('sha256').update(token).digest('hex');

const insertSession = db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)');
const deleteSession = db.prepare('DELETE FROM sessions WHERE token_hash = ?');
const dropExpired = db.prepare('DELETE FROM sessions WHERE expires_at < ?');

const selectSession = db.prepare(`
	SELECT u.id, u.discord_id, u.username, u.global_name, u.avatar, s.expires_at
	FROM sessions s JOIN users u ON u.id = s.user_id
	WHERE s.token_hash = ? AND s.expires_at > ?
`);

const upsertUser = db.prepare(`
	INSERT INTO users (discord_id, username, global_name, avatar, created_at, seen_at)
	VALUES (?, ?, ?, ?, ?, ?)
	ON CONFLICT (discord_id) DO UPDATE SET
		username = excluded.username,
		global_name = excluded.global_name,
		avatar = excluded.avatar,
		seen_at = excluded.seen_at
	RETURNING id
`);

function parseCookies(request) {
	const out = {};

	for (const part of (request.headers.cookie ?? '').split(';')) {
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
 * Secure ставим по тому же признаку, что и адрес возврата: на https-хостинге
 * кука обязана быть Secure, а на localhost с ней браузер её просто выбросит.
 */
function cookieHeader(name, value, maxAgeSeconds) {
	const secure = redirectUri().startsWith('https://') ? '; Secure' : '';
	const age = maxAgeSeconds === 0 ? '; Max-Age=0' : `; Max-Age=${maxAgeSeconds}`;
	return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax${secure}${age}`;
}

/** Кто прислал запрос, или null. Заодно изредка подчищает истёкшие сессии. */
export function currentUser(request) {
	const token = parseCookies(request)[SESSION_COOKIE];

	if (!token) {
		return null;
	}

	// Раз в сотню обращений выметаем просроченное: отдельного будильника ради
	// одной таблицы заводить не за чем.
	if (Math.random() < 0.01) {
		dropExpired.run(Date.now());
	}

	const row = selectSession.get(hashToken(token), Date.now());

	if (!row) {
		return null;
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

// ————— вход —————

/** Шаг первый: отправляем человека в Discord, запомнив одноразовый state. */
export function startLogin(response) {
	const state = crypto.randomBytes(24).toString('base64url');

	const query = new URLSearchParams({
		client_id: config.discordClientId,
		redirect_uri: redirectUri(),
		response_type: 'code',
		scope: 'identify',
		state,
		// prompt здесь не указан нарочно. С prompt=none Discord обещает провести
		// человека молча, но только того, кто уже разрешил приложению доступ:
		// всем остальным — а это ровно те, кто входит впервые, — он вместо входа
		// возвращает error=consent_required. Обычный экран согласия показывается
		// один раз и потом всё равно проскакивается сам.
	});

	response.writeHead(302, {
		// State живёт в куке, а не в памяти сервера: сравнение куки с тем, что
		// вернул Discord, и есть защита от чужой ссылки «войдите вот сюда».
		'Set-Cookie': cookieHeader(STATE_COOKIE, state, 600),
		Location: `${AUTHORIZE_URL}?${query}`,
	});

	response.end();
}

/**
 * Шаг второй: Discord вернул человека с кодом. Меняем код на токен, спрашиваем,
 * кто это, заводим сессию. Токен Discord после этого не нужен и не сохраняется:
 * сайт больше ничего от его имени не делает.
 */
export async function finishLogin(request, response, url) {
	const state = parseCookies(request)[STATE_COOKIE];
	const code = url.searchParams.get('code');

	const fail = message => {
		response.writeHead(302, {
			'Set-Cookie': cookieHeader(STATE_COOKIE, '', 0),
			Location: `/?login=${encodeURIComponent(message)}`,
		});
		response.end();
	};

	// Discord отказал сам — например, человек закрыл окно согласия. Его пояснение
	// куда полезнее нашего «что-то пошло не так», поэтому оно и уходит на страницу:
	// без него любой отказ выглядел как поломка сайта.
	const refused = url.searchParams.get('error');

	if (refused) {
		const details = url.searchParams.get('error_description') || refused;
		fail(refused === 'access_denied'
			? 'Вход отменён: Discord не получил разрешения'
			: `Discord отказал в входе: ${details}`);
		return;
	}

	if (!code || !state || state !== url.searchParams.get('state')) {
		fail('Вход не состоялся: запрос пришёл не отсюда или устарел');
		return;
	}

	const tokenResponse = await fetch(`${DISCORD_API}/oauth2/token`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: config.discordClientId,
			client_secret: config.discordClientSecret,
			grant_type: 'authorization_code',
			code,
			redirect_uri: redirectUri(),
		}),
	});

	if (!tokenResponse.ok) {
		// Почти всегда это несовпадение адреса возврата: Discord сверяет его
		// с точностью до символа, а PUBLIC_URL на хостинге легко забыть. Ответ
		// Discord прямо это и называет, поэтому уходит и в журнал, и на страницу.
		const reason = await tokenResponse.text().catch(() => '');
		console.error(`Discord не отдал токен (${tokenResponse.status}): ${reason}`);
		console.error(`Адрес возврата, который отправил сайт: ${redirectUri()}`);

		fail('Discord отказал в входе. Проверьте, что адрес возврата в настройках приложения '
			+ `совпадает с ${redirectUri()}`);
		return;
	}

	const { access_token: accessToken } = await tokenResponse.json();

	const meResponse = await fetch(`${DISCORD_API}/users/@me`, {
		headers: { Authorization: `Bearer ${accessToken}` },
	});

	if (!meResponse.ok) {
		fail('Не удалось прочитать профиль Discord');
		return;
	}

	const me = await meResponse.json();
	const now = Date.now();
	const { id: userId } = upsertUser.get(me.id, me.username ?? '', me.global_name ?? null, me.avatar ?? null, now, now);

	const token = crypto.randomBytes(32).toString('base64url');
	const maxAge = config.sessionDays * 24 * 60 * 60;
	insertSession.run(hashToken(token), userId, now, now + maxAge * 1000);

	response.writeHead(302, {
		'Set-Cookie': [
			cookieHeader(SESSION_COOKIE, token, maxAge),
			cookieHeader(STATE_COOKIE, '', 0),
		],
		Location: '/',
	});

	response.end();
}

export function logout(request, response) {
	const token = parseCookies(request)[SESSION_COOKIE];

	if (token) {
		deleteSession.run(hashToken(token));
	}

	response.writeHead(200, {
		'Set-Cookie': cookieHeader(SESSION_COOKIE, '', 0),
		'Content-Type': 'application/json; charset=utf-8',
	});

	response.end('{"ok":true}');
}

// ————— оценки —————

const upsertRating = db.prepare(`
	INSERT INTO ratings (pack_key, user_id, score, rated_at) VALUES (?, ?, ?, ?)
	ON CONFLICT (pack_key, user_id) DO UPDATE SET score = excluded.score, rated_at = excluded.rated_at
`);

const deleteRating = db.prepare('DELETE FROM ratings WHERE pack_key = ? AND user_id = ?');
const selectRating = db.prepare('SELECT COUNT(*) AS count, AVG(score) AS average FROM ratings WHERE pack_key = ?');

/**
 * Ставит оценку от 1 до 10 (полшага звезды — один балл) или снимает её,
 * если score = 0. Возвращает то, что показать на карточке.
 */
export function rate(packKeyValue, userId, score) {
	const value = Math.round(Number(score));

	if (value === 0) {
		deleteRating.run(packKeyValue, userId);
	} else if (Number.isFinite(value) && value >= 1 && value <= 10) {
		upsertRating.run(packKeyValue, userId, value, Date.now());
	} else {
		throw new Error('Оценка должна быть от 1 до 10 или 0, чтобы её снять');
	}

	const row = selectRating.get(packKeyValue);

	return {
		mine: value === 0 ? null : value,
		count: row.count,
		// Средний балл до порога наружу не отдаём вовсе: спрятать его на странице
		// мало — число всё равно уехало бы в браузер и нашлось бы в ответе API.
		average: row.count >= config.minRatingsForScore ? Math.round(row.average * 10) / 10 : null,
	};
}

// ————— чёрный список —————

const insertBlacklist = db.prepare(`
	INSERT OR REPLACE INTO blacklist (user_id, kind, value, label, added_at) VALUES (?, ?, ?, ?, ?)
`);

const deleteBlacklist = db.prepare('DELETE FROM blacklist WHERE user_id = ? AND kind = ? AND value = ?');
const selectBlacklist = db.prepare('SELECT kind, value, label, added_at FROM blacklist WHERE user_id = ? ORDER BY added_at DESC');

/**
 * Прячет от человека автора или пак. Автор хранится тем же ключом, каким сайт
 * ищет паки по автору (buildAuthorKey), пак — общим ключом всех своих копий:
 * скрыв пак, незачем натыкаться на него же под другим номером.
 */
export function setBlacklisted(userId, kind, value, label, blacklisted) {
	if (kind !== 'author' && kind !== 'pack') {
		throw new Error('В чёрный список попадают только авторы и паки');
	}

	const key = kind === 'author' ? buildAuthorKey(String(value ?? '')) : String(value ?? '').trim();

	if (!key) {
		throw new Error('Нечего добавлять в чёрный список');
	}

	if (blacklisted) {
		insertBlacklist.run(userId, kind, key, String(label ?? '').slice(0, 200), Date.now());
	} else {
		deleteBlacklist.run(userId, kind, key);
	}

	return { kind, value: key, blacklisted: Boolean(blacklisted) };
}

export function listBlacklist(userId) {
	return selectBlacklist.all(userId).map(row => ({
		kind: row.kind,
		value: row.value,
		label: row.label || row.value,
		addedAt: row.added_at,
	}));
}
