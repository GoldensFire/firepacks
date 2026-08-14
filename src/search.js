// Поиск по паку, терпимый к опечаткам.
//
// Обычный LIKE находит только точное вхождение: «гари потер» не находит ничего,
// хотя человек явно искал «Гарри Поттера». Поэтому каждое слово запроса ищется
// сначала как подстрока, а если не нашлось — сравнивается с началами слов пака
// с допуском на пару опечаток. Сам счёт живёт в fuzzy.js: им пользуется и сайт
// на Cloudflare, где никакого SQLite под рукой нет.
//
// Паков несколько сотен, поэтому подбор идёт в памяти, а найденное складывается
// во временную таблицу: так выдача, счётчик «найдено» и постраничность остаются
// одним SQL-запросом.

import { db } from './db.js';
import { normalizeText, buildEntry, matchEntry, SEARCH_FIELDS } from './fuzzy.js';

export { normalizeText };

let index = null;
let indexKey = '';

const stampQuery = db.prepare(`
	SELECT COUNT(*) AS c, MAX(id) AS id, MAX(indexed_at) AS indexed, MAX(summary_at) AS summary
	FROM packages WHERE status = 'ok'
`);

/**
 * Как часто спрашивать базу, не изменилась ли она. Сам вопрос недешёвый: два
 * из четырёх чисел — время правки и время описания, указателей на них нет,
 * и база вынуждена прочесть все строки целиком. На пятнадцати тысячах паков
 * это сотня миллисекунд, а спрашивается оно дважды на каждый запрос с поиском
 * (выдача и числа сложностей рядом с ней считаются порознь) — то есть впятеро
 * дороже самого подбора.
 *
 * Пять секунд — это про то, через сколько поиск заметит пак, разобранный прямо
 * сейчас, во время идущего обновления базы. В любое другое время база не меняется
 * вовсе, и заметить нечего.
 */
const STAMP_TTL = 5000;

let stamp = null;
let stampAt = 0;

/** Слепок базы: пока он не меняется, пересобирать список слов незачем. */
function currentKey() {
	if (stamp === null || Date.now() - stampAt > STAMP_TTL) {
		const row = stampQuery.get();

		stamp = `${row.c}|${row.id}|${row.indexed}|${row.summary}`;
		stampAt = Date.now();
	}

	return stamp;
}

function getIndex() {
	const key = currentKey();

	if (index && indexKey === key) {
		return index;
	}

	const rows = db.prepare(`SELECT ${SEARCH_FIELDS} FROM packages WHERE status = 'ok'`).all();

	index = rows.map(buildEntry);
	indexKey = key;
	return index;
}

/**
 * Собрать список слов заранее, не дожидаясь первого поиска. Зовётся сразу после
 * того, как сервер поднялся: сборка стоит полсекунды, и достаётся она тому, кто
 * первым что-нибудь наберёт, — а набирают обычно по букве, и полсекунды приходятся
 * ровно на первую. Здесь же они приходятся на пустой сервер, которого никто
 * ещё не спрашивал.
 */
export function warmSearch() {
	getIndex();
}

db.exec('CREATE TEMP TABLE IF NOT EXISTS search_hits (package_id INTEGER PRIMARY KEY, tier INTEGER NOT NULL)');

const clearHits = db.prepare('DELETE FROM search_hits');
const addHit = db.prepare('INSERT INTO search_hits (package_id, tier) VALUES (?, ?)');

/**
 * Что сейчас лежит в search_hits. Один запрос выдачи спрашивает отбор дважды —
 * сам список и числа сложностей рядом с ним (см. countLevels в src/server.js), —
 * и подбор в памяти шёл на оба раза заново: полторы сотни миллисекунд, потраченных
 * на то, чтобы получить ровно то же самое, что уже лежит в таблице.
 *
 * Ключом стоит и слепок базы: разобрался новый пак — прежнее найденное устарело.
 */
let hitsFor = null;

/**
 * Складывает найденное во временную таблицу search_hits. Рядом с паком пишется
 * tier: 0 — все слова нашлись как есть, 1 — где-то потребовалось простить опечатку.
 * Выдача сортируется сначала по нему, чтобы точные попадания не тонули среди похожих.
 *
 * @returns был ли поиск вообще (пустой запрос ничего не сужает)
 */
export function runSearch(text) {
	const tokens = normalizeText(text).split(' ').filter(Boolean);

	if (tokens.length === 0) {
		if (hitsFor !== null) {
			clearHits.run();
			hitsFor = null;
		}

		return false;
	}

	const entries = getIndex();
	const key = `${indexKey}\n${tokens.join(' ')}`;

	if (hitsFor === key) {
		return true;
	}

	clearHits.run();
	hitsFor = null;

	// Одной сделкой: каждая вставка по отдельности — это своя запись в журнал,
	// а находится по запросу и две тысячи паков
	db.exec('BEGIN');

	try {
		for (const entry of entries) {
			const tier = matchEntry(entry, tokens);

			if (tier >= 0) {
				addHit.run(entry.id, tier);
			}
		}

		db.exec('COMMIT');
	} catch (error) {
		db.exec('ROLLBACK');
		throw error;
	}

	hitsFor = key;
	return true;
}
