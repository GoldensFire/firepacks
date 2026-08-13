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

/** Слепок базы: пока он не меняется, пересобирать список слов незачем. */
function currentKey() {
	const row = db.prepare(`
		SELECT COUNT(*) AS c, MAX(id) AS id, MAX(indexed_at) AS indexed, MAX(summary_at) AS summary
		FROM packages WHERE status = 'ok'
	`).get();

	return `${row.c}|${row.id}|${row.indexed}|${row.summary}`;
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

db.exec('CREATE TEMP TABLE IF NOT EXISTS search_hits (package_id INTEGER PRIMARY KEY, tier INTEGER NOT NULL)');

const clearHits = db.prepare('DELETE FROM search_hits');
const addHit = db.prepare('INSERT INTO search_hits (package_id, tier) VALUES (?, ?)');

/**
 * Складывает найденное во временную таблицу search_hits. Рядом с паком пишется
 * tier: 0 — все слова нашлись как есть, 1 — где-то потребовалось простить опечатку.
 * Выдача сортируется сначала по нему, чтобы точные попадания не тонули среди похожих.
 *
 * @returns был ли поиск вообще (пустой запрос ничего не сужает)
 */
export function runSearch(text) {
	const tokens = normalizeText(text).split(' ').filter(Boolean);

	clearHits.run();

	if (tokens.length === 0) {
		return false;
	}

	for (const entry of getIndex()) {
		const tier = matchEntry(entry, tokens);

		if (tier >= 0) {
			addHit.run(entry.id, tier);
		}
	}

	return true;
}
