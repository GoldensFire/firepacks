// Сравнение слова запроса со словами пака, терпимое к опечаткам.
//
// Здесь только счёт: ни базы, ни выдачи этот файл не знает. Так вышло не ради
// красоты — тем же счётом пользуется двойник сайта на Cloudflare Workers (см. cf/),
// а он ходит в D1 совсем другими средствами. Разные половины должны прощать
// опечатки одинаково, иначе «гари потер» находил бы дома одно, а на сайте другое,
// и понять, кто из двоих прав, было бы не по чему.
//
// Кто как этим пользуется: src/search.js складывает найденное во временную
// таблицу SQLite, cf/src/search.js — в обычный Set. Всё остальное общее.

import { jsonOrDefault } from './keys.js';
import { toLatin } from './subject.js';

/**
 * Сколько опечаток прощаем слову запроса. Короткие слова не прощаем вовсе:
 * в трёх буквах одна ошибка — это уже другое слово.
 */
function allowedErrors(length) {
	if (length <= 3) {
		return 0;
	}

	return length <= 6 ? 1 : 2;
}

/** Регистр, ё и знаки препинания при поиске не важны. */
export function normalizeText(text) {
	return (text ?? '')
		.toLowerCase()
		.replace(/ё/g, 'е')
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim();
}

/**
 * Длина слова, начиная с которой оно ищется внутри слова пака, а не только с начала.
 * «васерманович» должно находить «СвоякВассерманович», но искать так короткие слова
 * нельзя: в четырёх буквах с допуском на ошибку совпадёт половина базы.
 */
const INFIX_LENGTH = 7;

/**
 * Насколько слово запроса непохоже на начало слова пака. Хвост слова пака
 * бесплатный: «потте» — это начало «поттера», а не ошибка на две буквы.
 * Перестановка соседних букв («поттре») считается одной ошибкой, а не двумя.
 *
 * @param anywhere искать не только с начала слова, но и с любого места внутри него
 * @returns расстояние или limit + 1, если оно заведомо больше допустимого
 */
function wordDistance(token, word, limit, anywhere) {
	const n = token.length;
	const m = word.length;

	let beforePrevious = null;
	let previous = new Array(m + 1);

	// Пропуск начала слова пака: бесплатный, когда ищем внутри слова, и по букве за шаг, когда с начала
	for (let j = 0; j <= m; j++) {
		previous[j] = anywhere ? 0 : j;
	}

	for (let i = 1; i <= n; i++) {
		const current = new Array(m + 1);
		current[0] = i;
		let best = i;

		for (let j = 1; j <= m; j++) {
			const cost = token[i - 1] === word[j - 1] ? 0 : 1;
			let value = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);

			if (i > 1 && j > 1 && token[i - 1] === word[j - 2] && token[i - 2] === word[j - 1]) {
				value = Math.min(value, beforePrevious[j - 2] + 1);
			}

			current[j] = value;

			if (value < best) {
				best = value;
			}
		}

		// Дальше расстояние только растёт: если вся строка уже хуже допуска, слово не подходит
		if (best > limit) {
			return limit + 1;
		}

		beforePrevious = previous;
		previous = current;
	}

	let best = limit + 1;

	for (let j = 0; j <= m; j++) {
		if (previous[j] < best) {
			best = previous[j];
		}
	}

	return best;
}

/** Строка, по которой ищется пак: название, файл, авторы, теги, описание, текст сообщения. */
function buildBlob(row) {
	const parts = [
		row.name,
		row.file_name,
		...jsonOrDefault(row.authors, []),
		...jsonOrDefault(row.tags, []),
		row.summary,
		row.comment_text,
	];

	return normalizeText(parts.filter(Boolean).join(' '));
}

/**
 * Строка базы в том виде, в каком её сравнивают со словами запроса: сплошная
 * строка для поиска подстрокой и отдельные слова для сравнения с допуском.
 *
 * Рядом лежит та же строка латиницей. Названия в паках сплошь русские, а ищут
 * их как придётся — «dota», «naruto», «vedmak»: переключать раскладку ради
 * строки поиска никто не станет. Когда кириллицы в строке нет, вторая копия
 * не заводится вовсе — это та же самая строка, и памяти она не стоит.
 */
export function buildEntry(row) {
	const blob = buildBlob(row);
	const spaced = ` ${blob} `;
	const latin = toLatin(blob);

	return {
		id: row.id,
		blob: spaced,
		latin: latin === blob ? spaced : ` ${latin} `,
		words: [...new Set(blob.split(' '))].filter(Boolean),
	};
}

/**
 * Совпадает ли слово запроса с паком.
 * @returns 'exact' — нашлось как есть, 'fuzzy' — нашлось с опечатками, null — не нашлось
 */
export function matchToken(entry, token) {
	if (entry.blob.includes(token)) {
		return 'exact';
	}

	// То же слово в другой раскладке: «dota» находит «Доту», «дота» — «Dota».
	// Только вхождением, без прощения опечаток: список слов латиницей — это
	// вторая такая же копия всей базы в памяти, а «нашлось не совсем то, что
	// набрали, да ещё и в другой раскладке» — уже гадание.
	if (entry.latin.includes(toLatin(token))) {
		return 'exact';
	}

	const limit = allowedErrors(token.length);

	if (limit === 0) {
		return null;
	}

	const anywhere = token.length >= INFIX_LENGTH;

	for (const word of entry.words) {
		// Слово пака короче запроса больше, чем на допуск: столько букв не дописать
		if (token.length - word.length > limit) {
			continue;
		}

		if (wordDistance(token, word, limit, anywhere) <= limit) {
			return 'fuzzy';
		}
	}

	return null;
}

/**
 * Насколько пак подходит запросу целиком: 0 — все слова нашлись как есть,
 * 1 — где-то пришлось простить опечатку, −1 — не подходит вовсе. Точные
 * попадания потом идут в выдаче первыми, чтобы не тонуть среди похожих.
 */
export function matchEntry(entry, tokens) {
	let tier = 0;

	for (const token of tokens) {
		const match = matchToken(entry, token);

		if (!match) {
			return -1;
		}

		if (match === 'fuzzy') {
			tier = 1;
		}
	}

	return tier;
}

/** Поля, которых хватает buildEntry. Обе половины сайта спрашивают базу одинаково. */
export const SEARCH_FIELDS = 'id, name, file_name, authors, tags, summary, comment_text';
