// Вход через Discord и всё, что к нему прилагается: сессии, оценки, чёрный список.
//
// Почему именно Discord: паки живут в обсуждении ВК, а играют в них в голосовых
// каналах, и второй регистрации ради оценки никто заводить не станет. Своих
// паролей сайт при этом не хранит вовсе — хранить нечего, а значит и терять.
//
// Схема самая обычная (authorization code), безо всяких библиотек: два запроса
// к Discord и кука с ключом сессии. Прав просим два — identify и email: первое
// даёт имя и аватар, второе — не саму почту, а признак того, что она в Discord
// подтверждена. Самой почты сайт не хранит: нужен один лишь этот признак.
//
// Ради него email и запрашивается. Пустой Discord-аккаунт заводится за минуту,
// и десяток таких накрутил бы паку любую оценку; аккаунт же с подтверждённой
// почтой требует хотя бы почтового ящика на каждый — накрутка из «минутного
// дела» превращается в возню. Обычному человеку при этом делать ничего не надо:
// у того, кто в Discord сидит, почта подтверждена давно.

import crypto from 'node:crypto';
import { config } from './config.js';
import { db, buildAuthorKey } from './db.js';

const DISCORD_API = 'https://discord.com/api/v10';
const AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';

// Прав просим два, и второе — тот самый email (см. заголовок файла). Без него
// Discord не вернёт ни почту, ни признак её подтверждения, и не пустило бы никого.
const SCOPE = 'identify email';

/** Отказ, ради которого всё и затевалось. Текст один на оба отказа — и когда
    почта не подтверждена, и когда Discord о ней вовсе промолчал: снаружи это
    одно и то же, «войти нельзя, идите подтвердите почту». */
const EMAIL_NOT_VERIFIED = 'Для входа необходимо подтвердить адрес электронной почты в Discord.';

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
const selectUserByDiscord = db.prepare('SELECT id FROM users WHERE discord_id = ?');
const deleteUserSessions = db.prepare('DELETE FROM sessions WHERE user_id = ?');
const dropExpired = db.prepare('DELETE FROM sessions WHERE expires_at < ?');
const renewSession = db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?');

const DAY = 24 * 60 * 60 * 1000;

/**
 * Отодвинуть конец сессии, если он приблизился. Отодвигается срок в базе, а не
 * кука: куку без ответа не переставить, а до какого именно ответа доживёт эта
 * проверка — заранее не известно. Поэтому кука выдаётся сразу надолго
 * (cookieDays), а настоящий срок хранится здесь и продлевается посещением.
 *
 * Реже, чем раз в sessionRenewDays, база при этом не трогается: иначе запись
 * шла бы на каждое открытие страницы.
 */
function renewIfNeeded(tokenHash, expiresAt, now) {
	const fresh = now + config.sessionDays * DAY;

	if (expiresAt < fresh - config.sessionRenewDays * DAY) {
		renewSession.run(fresh, tokenHash);
	}
}

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

/**
 * Хозяин ли это сайта — тот, чей Discord назван в config.adminIds.
 *
 * Сверяется именно Discord-идентификатор, а не номер строки в таблице users:
 * строки заводятся по мере того, как люди входят, и у одного и того же человека
 * дома и на хостинге номера разные. Discord-номер один и тот же везде и навсегда.
 */
export const isAdmin = discordId => config.adminIds.includes(String(discordId));

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

	const now = Date.now();
	const hash = hashToken(token);
	const row = selectSession.get(hash, now);

	if (!row) {
		return null;
	}

	// Пришёл — значит, сайтом пользуются, и конец сессии отодвигается
	renewIfNeeded(hash, row.expires_at, now);

	return {
		id: row.id,
		discordId: row.discord_id,
		admin: isAdmin(row.discord_id),
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
		scope: SCOPE,
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

	let tokenResponse;

	try {
		tokenResponse = await fetch(`${DISCORD_API}/oauth2/token`, {
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
	} catch (error) {
		// Discord недоступен: сеть, срезанный DNS, упавший discord.com. Раньше
		// такое вылетало наружу пятисотой страницей — а это не поломка сайта,
		// и человеку полезнее знать, что попытку можно повторить.
		console.error(`Discord не ответил на запрос токена: ${error.message}`);
		fail('Discord не отвечает. Попробуйте войти ещё раз через минуту');
		return;
	}

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

	const { access_token: accessToken } = await tokenResponse.json().catch(() => ({}));

	if (!accessToken) {
		console.error('Discord ответил на запрос токена без access_token');
		fail('Discord не отдал ключ доступа. Попробуйте войти ещё раз');
		return;
	}

	let meResponse;

	try {
		meResponse = await fetch(`${DISCORD_API}/users/@me`, {
			headers: { Authorization: `Bearer ${accessToken}` },
		});
	} catch (error) {
		console.error(`Discord не ответил на запрос профиля: ${error.message}`);
		fail('Discord не отвечает. Попробуйте войти ещё раз через минуту');
		return;
	}

	if (!meResponse.ok) {
		fail('Не удалось прочитать профиль Discord');
		return;
	}

	const me = await meResponse.json().catch(() => null);

	// Номер аккаунта — то единственное, чем человек в базе и опознаётся. Приходит
	// он строкой, но приводится к ней явно: дальше он идёт в запросы, а не в текст,
	// и что именно окажется в ответе, решает не сайт.
	const discordId = String(me?.id ?? '');

	if (!discordId) {
		console.error('Discord отдал профиль без id');
		fail('Не удалось прочитать профиль Discord');
		return;
	}

	// ————— главная преграда накрутке —————
	//
	// Признак берётся из ответа Discord на серверной стороне и только отсюда:
	// со страницы его не подменить, потому что страница его и не касается —
	// она лишь показывает то, чем кончился вход.
	//
	// verified !== true, а не === false: если прав email не дали или Discord
	// поля не прислал вовсе, признака нет, а «нет признака» — это не «почта
	// подтверждена». Пускать в такой случае значило бы обходить проверку,
	// просто убрав из ответа поле.
	if (me.verified !== true) {
		// Отказ распространяется и на тех, кто вошёл до этой проверки: пока
		// у аккаунта не подтверждена почта, ни одной живой сессии у него быть
		// не должно, а не только новой. Чужих сессий это не трогает — сносятся
		// строки ровно того аккаунта, которому сейчас отказали.
		const known = selectUserByDiscord.get(discordId);

		if (known) {
			deleteUserSessions.run(known.id);
		}

		fail(EMAIL_NOT_VERIFIED);
		return;
	}

	const now = Date.now();
	const { id: userId } = upsertUser.get(discordId, me.username ?? '', me.global_name ?? null, me.avatar ?? null, now, now);

	const token = crypto.randomBytes(32).toString('base64url');
	insertSession.run(hashToken(token), userId, now, now + config.sessionDays * DAY);

	response.writeHead(302, {
		'Set-Cookie': [
			// Кука выдаётся надолго, а настоящий срок живёт в базе и отодвигается
			// посещениями (см. renewIfNeeded): протухшая сессия всё равно никого
			// не пустит, а протухшая кука выкинула бы того, кто заходил вчера
			cookieHeader(SESSION_COOKIE, token, config.cookieDays * 24 * 60 * 60),
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
