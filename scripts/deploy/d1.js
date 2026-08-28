// Заливка базы в D1 — по одному запросу, а не файлом.
//
// `wrangler d1 execute --file` кладёт файл на сторону D1 и просит его
// «импортировать». Импорт у D1 — работа исключительная: пока он идёт, база
// не отвечает никому, и сайт всё это время отдаёт «Currently processing
// a long-running import» вместо паков. Поэтому те же самые запросы отправляются
// по одному обычным способом (D1 REST, /query): чтения они не блокируют вовсе,
// и посетитель видит то старую строку, то новую, но список паков у него
// открывается всегда.
//
// Файлом заливается только местная копия (--local): там ни импорта,
// ни посетителей.

import fs from 'node:fs';
import path from 'node:path';
import { local, root } from './options.js';
import { BUSY_WAITS, CLOUDFLARE_ENV, execute, IMPORT_BUSY, sleep } from './wrangler.js';

/** Куда стучаться напрямую, без wrangler. */
export const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';

/** Номер базы D1. Лежит в wrangler.jsonc — его туда вписывает `npm run cf:setup`. */
export function databaseId() {
	const config = fs.readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8');

	return /"database_id"\s*:\s*"([^"]+)"/.exec(config)?.[1] ?? '';
}

/**
 * Номер учётной записи. Обычно он не нужен вовсе — wrangler находит её сам, —
 * но REST без него не работает: адрес запроса начинается с учётной записи.
 *
 * Поэтому если его не сказали ни переменной, ни файлом, спрашиваем сами:
 * учётных записей у ключа чаще всего одна, а когда их несколько, нужную видно
 * по базе — она в ней или её там нет.
 */
let knownAccount = null;

export async function accountId() {
	if (knownAccount !== null) {
		return knownAccount;
	}

	if (CLOUDFLARE_ENV.CLOUDFLARE_ACCOUNT_ID) {
		knownAccount = CLOUDFLARE_ENV.CLOUDFLARE_ACCOUNT_ID;
		return knownAccount;
	}

	const response = await fetch(`${CLOUDFLARE_API}/accounts`, {
		headers: { Authorization: `Bearer ${CLOUDFLARE_ENV.CLOUDFLARE_API_TOKEN}` },
	});

	const body = await response.json().catch(() => null);
	const accounts = body?.result ?? [];

	for (const account of accounts) {
		const check = await fetch(`${CLOUDFLARE_API}/accounts/${account.id}/d1/database/${databaseId()}`, {
			headers: { Authorization: `Bearer ${CLOUDFLARE_ENV.CLOUDFLARE_API_TOKEN}` },
		});

		if (check.ok) {
			knownAccount = account.id;
			return knownAccount;
		}
	}

	console.error('\nCloudflare не показал учётной записи, в которой лежит база firepacks.');
	console.error('Впишите её номер в data/cloudflare-account.txt (dash.cloudflare.com, справа внизу).');
	process.exit(1);
}

/**
 * Один запрос к базе наверху. Отказ возвращается строкой, а не бросается:
 * решать, ждать его или сдаваться, будет позвавший (см. IMPORT_BUSY).
 *
 * @returns {Promise<string|null>} null — получилось; строка — чем ругались
 */
async function askDatabase(sql) {
	const account = await accountId();

	let response;

	try {
		response = await fetch(`${CLOUDFLARE_API}/accounts/${account}/d1/database/${databaseId()}/query`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${CLOUDFLARE_ENV.CLOUDFLARE_API_TOKEN}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ sql }),
		});
	} catch (error) {
		// Оборванная сеть — не отказ базы, а помеха по дороге: такое повторяют
		return `сеть: ${error.message}`;
	}

	const body = await response.json().catch(() => null);

	if (response.ok && body?.success) {
		return null;
	}

	const complaints = (body?.errors ?? []).map(item => item.message).filter(Boolean);

	return complaints.join('; ') || `HTTP ${response.status}`;
}

/**
 * Отказы, которые проходят сами: чужая заливка (см. IMPORT_BUSY), обрыв сети
 * и «слишком часто» от самого Cloudflare. Всё остальное — наша ошибка в SQL,
 * и повторять её бессмысленно.
 */
const WORTH_RETRY = /^сеть: |too many requests|rate limit|HTTP (429|5\d\d)|internal error|network connection lost/i;

/**
 * Разбор выгрузки на отдельные запросы.
 *
 * Резать по «;» напрямую нельзя: точка с запятой попадается и внутри строк —
 * в названиях тем («Игры;Кино;Мир»), в тексте сообщения, в описании. Поэтому
 * идём по знакам и считаем апострофы: удвоенный апостроф внутри строки («don''t»)
 * закрывает её и тут же открывает снова, то есть сам собой считается правильно.
 */
function statementsOf(sql) {
	const statements = [];
	let start = 0;
	let quoted = false;

	for (let i = 0; i < sql.length; i++) {
		const symbol = sql[i];

		if (quoted) {
			if (symbol === "'") {
				quoted = false;
			}

			continue;
		}

		if (symbol === "'") {
			quoted = true;
			continue;
		}

		// Пояснение до конца строки: им начинается каждый файл выгрузки
		if (symbol === '-' && sql[i + 1] === '-') {
			const end = sql.indexOf('\n', i);
			i = end === -1 ? sql.length : end;
			continue;
		}

		if (symbol === ';') {
			const statement = sql.slice(start, i).trim();

			if (statement) {
				statements.push(statement);
			}

			start = i + 1;
		}
	}

	const rest = sql.slice(start).trim();

	if (rest) {
		statements.push(rest);
	}

	return statements;
}

/**
 * Заливка файла запрос за запросом. Медленнее файла целиком, зато сайт всё это
 * время открывается — ради этого всё и затевалось (см. шапку файла).
 *
 * По одному, а не пачками и не в несколько потоков, нарочно: в выгрузке
 * попадаются DELETE перед INSERT по тем же строкам (см. scripts/export-d1.js),
 * и порядок здесь — не формальность.
 */
async function pourByQueries(file) {
	const full = path.isAbsolute(file) ? file : path.join(root, file);
	const statements = statementsOf(fs.readFileSync(full, 'utf8'));

	console.log(`\n$ ${path.basename(file)}: ${statements.length} запрос(ов) в базу наверху`);

	for (let index = 0; index < statements.length; index++) {
		for (let attempt = 0; ; attempt += 1) {
			const complaint = await askDatabase(statements[index]);

			if (!complaint) {
				break;
			}

			const busy = IMPORT_BUSY.test(complaint);

			if (!busy && !WORTH_RETRY.test(complaint)) {
				console.error(`\nБаза наверху отказала на запросе ${index + 1} из ${statements.length}:`);
				console.error(complaint);
				console.error('\nДома всё цело: отметка «доехало» не ставится до конца, и следующая');
				console.error('отправка пошлёт те же строки заново.');
				process.exit(1);
			}

			if (attempt >= BUSY_WAITS.length) {
				console.error(`\nНе дождались: ${complaint}`);
				console.error('Следующая отправка пошлёт те же строки заново.');
				process.exit(1);
			}

			const wait = BUSY_WAITS[attempt];

			console.log(busy
				? `Наверху идёт чужая заливка — ждём ${wait} с и пробуем снова.`
				: `Не прошло (${complaint}) — ждём ${wait} с и пробуем снова.`);

			sleep(wait);
		}

		// Каждый пятидесятый — чтобы по логу было видно, что заливка идёт,
		// и при этом он не превращался в простыню из трёхсот строк
		if ((index + 1) % 50 === 0) {
			console.log(`  ${index + 1} из ${statements.length}`);
		}
	}
}

/**
 * Залить файл наверх. Чем — решается здесь: обычными запросами, если есть ключ,
 * и по-старому файлом, если его нет.
 *
 * Второй путь остался не для красоты: без постоянного ключа REST невозможен вовсе
 * (пропуском из браузера он не пользуется), а выкладка руками после `wrangler login`
 * — обычное дело. Сайт при этом на время заливки ляжет, но лучше так, чем никак.
 */
export async function pour(file) {
	if (local || !CLOUDFLARE_ENV.CLOUDFLARE_API_TOKEN) {
		execute(file);
		return;
	}

	await pourByQueries(file);
}
