// Поиск, терпимый к опечаткам, — та же половина работы, что и в src/search.js,
// только найденное складывается не во временную таблицу SQLite, а в обычный Set:
// временных таблиц у D1 нет, а если бы и были, каждый запрос сюда приходит
// в свой изолят и общей временной таблицы у них всё равно не вышло бы.
//
// Сам счёт — в src/fuzzy.js, общий с домашним сайтом.

import {
	normalizeText, buildEntry, entryFromLine, matchEntry, rankEntry, RANK_REST, SEARCH_FIELDS,
} from '../../src/fuzzy.js';

/**
 * Список слов всех паков. Живёт в изоляте: Cloudflare держит его между
 * запросами, пока тот кому-то нужен, и одиннадцать тысяч паков перечитываются
 * не на каждый запрос, а раз в несколько минут.
 *
 * Срок нужен только на случай, когда базу залили, а Worker не перевыкладывали:
 * обычная выкладка поднимает новые изоляты, и список собирается заново сам.
 */
const INDEX_TTL = 10 * 60 * 1000;

/** Готовый список слов, собранный при сборке статики (см. scripts/build-web.js). */
const INDEX_FILE = '/search-index.txt';

let index = null;
let indexAt = 0;

/**
 * Откуда берётся список.
 *
 * Обычно — из статики: там он лежит уже разобранным на слова, и Worker
 * только раскладывает строки. Собирать его самому — из D1, разбирая каждый
 * пак заново, — стоило 1.3 секунды процессора на первый поиск в изоляте,
 * и Cloudflare такие изоляты убивает вместе со всеми запросами, которые
 * в них в этот миг обслуживались (см. writeSearchIndex в scripts/build-web.js).
 *
 * Из базы — только если файла нет: так бывает ровно один раз, между выкладкой
 * нового Worker и выкладкой новой статики. Лучше медленный поиск, чем никакой.
 */
async function getIndex(db, assets, base) {
	if (index && Date.now() - indexAt < INDEX_TTL) {
		return index;
	}

	index = (assets && base ? await fromAssets(assets, base) : null) ?? await fromDatabase(db);
	indexAt = Date.now();
	return index;
}

async function fromAssets(assets, base) {
	try {
		const response = await assets.fetch(new URL(INDEX_FILE, base));

		if (!response.ok) {
			return null;
		}

		const text = await response.text();

		return text ? text.split('\n').map(entryFromLine) : null;
	} catch {
		return null;
	}
}

async function fromDatabase(db) {
	const { results } = await db.prepare(
		`SELECT ${SEARCH_FIELDS} FROM packages WHERE status = 'ok'`,
	).all();

	return results.map(buildEntry);
}

/**
 * Номера подошедших паков, разложенные по точности попадания. Пустой запрос
 * ничего не сужает — тогда null, и выдача идёт как есть.
 *
 * Рядом — те же номера, разложенные по ступеням совпадения с названием (см.
 * rankEntry в src/fuzzy.js): по ним сортирует «по совпадению с запросом».
 * Ступеней шесть, и хранятся они списками номеров, а не числом при паке:
 * временных таблиц у D1 нет, и порядок приходится складывать прямо в SQL.
 *
 * @returns {Promise<{exact: number[], fuzzy: number[], ranks: number[][]} | null>}
 */
export async function findHits(db, text, assets = null, base = null) {
	const tokens = normalizeText(text).split(' ').filter(Boolean);

	if (tokens.length === 0) {
		return null;
	}

	const exact = [];
	const fuzzy = [];
	const ranks = Array.from({ length: RANK_REST + 1 }, () => []);

	for (const entry of await getIndex(db, assets, base)) {
		const tier = matchEntry(entry, tokens);

		if (tier < 0) {
			continue;
		}

		if (tier === 0) {
			exact.push(entry.id);
		} else {
			fuzzy.push(entry.id);
		}

		ranks[rankEntry(entry, tokens, text)].push(entry.id);
	}

	return { exact, fuzzy, ranks };
}

/**
 * Ступень совпадения выражением SQL: «сначала те, чьё название и есть запрос,
 * потом те, у кого он в начале названия, и так далее». Последняя ступень отдельным
 * условием не нужна — всё, что не попало в предыдущие, и есть она.
 */
export function rankOrder(hits) {
	const cases = hits.ranks
		.slice(0, -1)
		.map((ids, rank) => (ids.length > 0 ? `WHEN p.id IN (${idList(ids)}) THEN ${rank}` : ''))
		.filter(Boolean);

	return cases.length > 0 ? `(CASE ${cases.join(' ')} ELSE ${hits.ranks.length - 1} END)` : null;
}

/**
 * Список номеров прямо в текст запроса, а не параметрами. Так можно: номера
 * пришли из этой же базы и числами быть обязаны — подставлять туда чужую
 * строку неоткуда. Параметрами их пришлось бы связывать по одному, а их
 * бывает под полтысячи, и предел числа параметров ближе, чем кажется.
 *
 * Пустой список превращается в заведомо ложное условие: «IN ()» — не SQL.
 */
export function idList(ids) {
	return ids.length > 0 ? ids.map(id => Number(id)).join(',') : '-1';
}
