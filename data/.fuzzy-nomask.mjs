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
	const name = normalizeText(row.name);

	return {
		id: row.id,
		blob: spaced,
		latin: latin === blob ? spaced : ` ${latin} `,
		words: [...new Set(blob.split(' '))].filter(Boolean),
		// Отдельно от blob: по названию пак ставится в выдаче выше, чем по описанию
		// или тексту сообщения (см. rankEntry)
		name,
		nameLatin: toLatin(name),
		nameWords: [...new Set(name.split(' '))].filter(Boolean),
	};
}

/**
 * Тот же пак, но одной строкой: так он ложится в заранее собранный список слов
 * (см. searchIndex в scripts/build-web.js).
 *
 * Разделитель — табуляция, и подойти она может только потому, что в нормальном
 * виде строки её нет: normalizeText оставляет буквы, цифры и одиночные пробелы.
 * Пустое поле означает «то же самое, что и предыдущее»: у пака с латинским
 * названием строка латиницей — та же самая строка, и второй раз её не пишем.
 */
export function entryLine(row) {
	const entry = buildEntry(row);
	const blob = entry.blob.trim();
	const latin = entry.latin.trim();

	return [
		entry.id,
		blob,
		latin === blob ? '' : latin,
		entry.name,
		entry.nameLatin === entry.name ? '' : entry.nameLatin,
	].join('\t');
}

/**
 * Разбор такой строки обратно.
 *
 * Слова (words, nameWords) считаются не здесь, а при первом обращении. Разница
 * заметная: разложить одиннадцать тысяч паков на слова — шестьдесят миллисекунд
 * чужого процессора, и платить их запросу, который ответит одним вхождением
 * подстроки, незачем. Нужны слова только там, где прощаются опечатки.
 */
export function entryFromLine(line) {
	const [id, blob, latin, name, nameLatin] = line.split('\t');
	const spaced = ` ${blob} `;

	const entry = {
		id: Number(id),
		blob: spaced,
		latin: latin ? ` ${latin} ` : spaced,
		name,
		nameLatin: nameLatin || name,
	};

	lazyWords(entry, 'words', blob);
	lazyWords(entry, 'nameWords', name);

	return entry;
}

/** Список слов, посчитанный при первом обращении и потом лежащий готовым. */
function lazyWords(entry, key, source) {
	let words = null;

	Object.defineProperty(entry, key, {
		get() {
			if (words === null) {
				words = [...new Set(source.split(' '))].filter(Boolean);
			}

			return words;
		},
	});
}

/**
 * Набор букв слова, сложенный в тридцать два бита: буква кладётся в свой бит
 * по остатку от деления кода на 32.
 *
 * Букв в двух алфавитах больше тридцати двух, и в один бит их попадает
 * по нескольку — это нарочно. Отпечаток нужен не для сравнения слов, а для
 * отказа от сравнения (см. fuzzyInWords), и совпадение разных букв в одном
 * бите делает отказ реже, но никогда — ошибочным.
 */
function letterMask(word) {
	let mask = 0;

	for (let i = 0; i < word.length; i++) {
		mask |= 1 << (word.charCodeAt(i) % 32);
	}

	return mask;
}

/** Сколько единиц в числе: столько букв запроса в слове не встретилось вовсе. */
function bitCount(value) {
	let count = 0;

	for (let bits = value; bits !== 0; bits &= bits - 1) {
		count++;
	}

	return count;
}

/**
 * Нашлось ли слово запроса среди слов пака с допуском на опечатки.
 *
 * Перед честным сравнением стоят две дешёвые проверки, и обе отсекают только
 * то, что заведомо не подойдёт. Считать расстояние — это n×m шагов на каждую
 * пару, а слов у пака сотни: запрос из мусорных букв («КРутОйПААКЕТ)00»)
 * обходился в 190 мс чужого процессора, потому что не совпадал ни с чем
 * и оттого честно сравнивался со всем.
 *
 * Вторая проверка — про буквы. Каждой буквы запроса, которой в слове нет вовсе,
 * стоит хотя бы одна правка: не хватает трёх букв при допуске в две — можно
 * не сравнивать. Отпечаток слова считается тут же и стоит одного прохода
 * по нему, то есть в разы меньше самого сравнения.
 */
function fuzzyInWords(words, token) {
	const limit = allowedErrors(token.length);

	if (limit === 0) {
		return false;
	}

	const anywhere = token.length >= INFIX_LENGTH;
	const tokenMask = letterMask(token);

	for (const word of words) {
		// Слово пака короче запроса больше, чем на допуск: столько букв не дописать
		if (token.length - word.length > limit) {
			continue;
		}


		if (wordDistance(token, word, limit, anywhere) <= limit) {
			return true;
		}
	}

	return false;
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

	return fuzzyInWords(entry.words, token) ? 'fuzzy' : null;
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

/**
 * Насколько попадание похоже на «то самое»: 0 — название пака и есть запрос,
 * дальше по убыванию, RANK_REST — нашлось где-то ещё: в описании, в тегах,
 * в тексте сообщения, у автора.
 *
 * Ради этого счёта и заведена сортировка «по совпадению с запросом»: набрав
 * «Большая солянка», человек ждёт сверху пак с таким названием, а не пак,
 * у которого эти два слова случайно встретились в описании. Прежде выдача
 * шла по времени сообщения, и пак с точным названием мог оказаться на третьей
 * странице просто потому, что он старый.
 *
 * Ступени такие:
 *   0 — название и есть запрос;
 *   1 — с запроса название начинается;
 *   2 — запрос стоит где-то внутри названия;
 *   3 — все слова запроса нашлись в названии порознь;
 *   4 — то же, но с прощёнными опечатками: «гари потер» — это «Гарри Поттер»;
 *   5 — в названии нашлась только часть слов запроса;
 *   6 — в названии нет ничего, пак нашёлся не по нему.
 *
 * Они нарочно грубые: внутри одной ступени порядок задаёт обычная сортировка
 * (по умолчанию — сначала новые), и дробить их мельче значило бы выдумывать
 * точность там, где её нет.
 */
export const RANK_REST = 6;

/** Название целиком: 0 — оно и есть запрос, 1 — с него начинается, 2 — где-то внутри. */
function wholeNameRank(name, query) {
	if (!name || !query) {
		return null;
	}

	if (name === query) {
		return 0;
	}

	if (name.startsWith(query)) {
		return 1;
	}

	return name.includes(query) ? 2 : null;
}

/**
 * Ступень пака для сортировки по совпадению. Раскладка учитывается так же, как
 * и в самом поиске: «vedmak» находит «Ведьмака» — и наверх его ставит тоже.
 */
export function rankEntry(entry, tokens, query) {
	const normalized = normalizeText(query);

	if (!normalized) {
		return RANK_REST;
	}

	const whole = Math.min(
		wholeNameRank(entry.name, normalized) ?? RANK_REST,
		wholeNameRank(entry.nameLatin, toLatin(normalized)) ?? RANK_REST,
	);

	if (whole < RANK_REST) {
		return whole;
	}

	// Слова запроса порознь: «солянка большая» — это тот же пак, что и «большая
	// солянка», хотя целиком строка в название не попадает
	const spaced = ` ${entry.name} `;
	const spacedLatin = ` ${entry.nameLatin} `;
	const inName = token => spaced.includes(token) || spacedLatin.includes(toLatin(token));

	if (tokens.every(inName)) {
		return 3;
	}

	// Прощённая опечатка в названии — это всё ещё попадание по названию, и стоять
	// оно должно выше точного попадания в чужом описании: «гари потер» ищут пак
	// про Гарри Поттера, а не пак, где он упомянут в перечислении тем
	const nearName = token => inName(token) || fuzzyInWords(entry.nameWords, token);

	if (tokens.every(nearName)) {
		return 4;
	}

	return tokens.some(nearName) ? 5 : RANK_REST;
}

/** Поля, которых хватает buildEntry. Обе половины сайта спрашивают базу одинаково. */
export const SEARCH_FIELDS = 'id, name, file_name, authors, tags, summary, comment_text';
