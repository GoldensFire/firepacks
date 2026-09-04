// Всё о паке одним запросом: и разметка тем, и описание, и аудитория, и язык.
//
// Заменяет собой два шага сразу, и не ради красоты. Вопрос у разметки
// и описания общий — список тем пака, — а суточный лимит Gemini считает
// запросы; задав его дважды, обход исчерпывал бы лимит вдвое быстрее и делал
// за ночь вдвое меньше паков.
//
// Своих правил здесь нет ни одного: и текст запроса, и чистка ответа взяты
// у тех же файлов, что отвечают за каждую половину порознь (theme-prompt.js,
// themes.js, summary.js). Так и задумано — расходись они, один и тот же пак
// размечался бы по-разному в зависимости от того, каким шагом его спросили.

import { ask, GeminiError } from './api.js';
import { SCHEMA, THEME_RULES } from './theme-prompt.js';
import { classifyThemes, collectMarks, marked } from './themes.js';
import {
	AUDIENCE_FIELDS, AUDIENCE_RULES, LANGUAGE_RULES, PACK_CONTEXT, SUMMARY_RULES,
	SUMMARY_TRANSLATIONS, cleanAudience, cleanLanguage, cleanSummary, cleanTranslations,
	describePack, packAbout,
} from './summary.js';

// ————— всё про пак одним запросом —————

const ANALYZE_INSTRUCTION = `Ты разбираешь пакет вопросов для игры «Своя игра».
Работы четыре, и делаются они за один раз, по одному и тому же списку тем.

${PACK_CONTEXT}

ПЕРВОЕ — разбери темы пака по одной.
${THEME_RULES}

ВТОРОЕ — опиши весь пак одной короткой фразой (поле s): по ней человек поймёт,
что внутри. У каждой темы после тире идёт выжимка её содержимого: ответы
на вопросы и куски самих вопросов, через « / ». Именно она и говорит, о чём пак
на самом деле.
${SUMMARY_RULES}

ТРЕТЬЕ — назови целевую аудиторию всего пака: возраст и пол тех, кому он интересен.
${AUDIENCE_RULES}

ЧЕТВЁРТОЕ — назови язык, на котором пак написан (поле lg).
${LANGUAGE_RULES}

Ответь одним объектом JSON: поле s — фраза про весь пак, поля se, su и sk —
она же на остальных языках, поля af, at и mp — про его аудиторию, поле lg —
его язык, поле t — массив, по объекту на каждую тему, в том же порядке,
в каком темы даны.`;

/**
 * Список тем пака для запроса. Нумерация своя у каждого пака и начинается с нуля:
 * по этому номеру ответ модели и возвращается на своё место (поле i).
 */
function themeLines(themes) {
	if (themes.length === 0) {
		return '\n\n(тем в паке разобрать не удалось: t оставь пустым массивом, а описание составь '
			+ 'по названию и тегам — не найдёшь смысла, верни пустую строку)';
	}

	const lines = themes.map((theme, index) => {
		const media = theme.media ? ` [в теме много: ${theme.media}]` : '';
		const sample = theme.sample ? `\n   ответы: ${theme.sample}` : '';
		return `${index}. «${theme.name}»${media}${sample}`;
	});

	return `\n\nТемы:\n${lines.join('\n')}`;
}

const ANALYZE_SCHEMA = {
	type: 'OBJECT',
	properties: {
		s: { type: 'STRING' },
		...SUMMARY_TRANSLATIONS,
		...AUDIENCE_FIELDS,
		t: SCHEMA,
	},
	// lg здесь обязателен наравне с прочим, и это не мелочь. Пока его в списке
	// не было, модель поля просто не заполняла — вопрос про язык в запросе стоял,
	// а в ответе его не оказывалось, и язык оставался неизвестным у тринадцати
	// тысяч паков из четырнадцати. Переводы описания стоят в списке по той же
	// причине: необязательное поле модель молча пропускает
	required: ['s', ...Object.keys(SUMMARY_TRANSLATIONS), 'af', 'at', 'mp', 'lg', 't'],
};

/**
 * Всё, что модель может сказать про пак, за один запрос: и категория каждой темы,
 * и краткое описание пака целиком.
 *
 * Зачем так. Суточный лимит бесплатного ключа считает запросы, а не темы и не
 * токены: у лёгких моделей их пятьсот в сутки, у старших двадцать. Раньше пак
 * стоил два запроса — один на проценты, другой на описание, — и делались они
 * порознь, хотя вопрос задавался по одному и тому же списку тем. То есть половина
 * суточного лимита уходила на то, чтобы отправить те же самые темы второй раз.
 * Теперь пак стоит один запрос, и за ночь их проходит вдвое больше.
 *
 * Заодно от этого лучше и само описание: модель составляет его, уже разобрав
 * каждую тему по отдельности, — а не отдельным заходом, где темы для неё снова
 * просто список названий.
 *
 * Если ответ не влез (пак на две сотни тем) или сорвался — работа делается
 * по-старому, двумя запросами. Это дороже ровно на тех паках, где случилось,
 * и ничего не теряет.
 *
 * @param {{name: string, themes: Array}} pack темы из listThemes
 * @returns {Promise<{marks: Map, summary: string, audience: object|null, queries: string[], split: boolean}>}
 */
export async function analyzePack(pack) {
	const themes = pack.themes ?? [];
	const prompt = `${ANALYZE_INSTRUCTION}\n\nПак: «${pack.name ?? ''}»${packAbout(pack)}${themeLines(themes)}`;

	try {
		const { value, queries } = await ask(prompt, ANALYZE_SCHEMA, { search: true });
		const answers = Array.isArray(value?.t) ? value.t : [];

		// Ответ короче списка тем — модель уперлась в предел длины и оборвалась
		// на середине. Молчание про хвост тем засчиталось бы как «прочее»,
		// и пак получил бы доли из ничего (см. classifyThemes)
		if (answers.length < themes.length) {
			throw new GeminiError(`ответ оборван: ${answers.length} тем из ${themes.length}`, 0);
		}

		const marks = collectMarks(themes, answers);

		// Ответ есть, а разобранных тем в нём нет ни одной — значит, он не про этот
		// пак: либо номера тем чужие, либо категории не из списка. Записать такое
		// значило бы навсегда объявить пак «прочим» (см. alignAnswers)
		if (themes.length > 0 && marked(marks) === 0) {
			throw new GeminiError('ни одна тема не разобрана', 0);
		}

		return {
			marks,
			summary: cleanSummary(value?.s),
			translations: cleanTranslations(value),
			audience: cleanAudience(value),
			language: cleanLanguage(value?.lg),
			queries,
			split: false,
		};
	} catch (error) {
		// Отвечать нечем — ключ, модель или кончившиеся лимиты: второй заход
		// получит ровно тот же отказ, только вдвое дороже
		if (error.fatal === true || themes.length === 0) {
			throw error;
		}

		const marks = await classifyThemes(themes);
		const { summary, translations, audience, language } = await describePack({ ...pack, themes });

		return { marks, summary, translations, audience, language, queries: [], split: true, reason: error.message };
	}
}

// ————— несколько паков одним запросом —————

const PACKS_INSTRUCTION = `Ты разбираешь пакеты вопросов для игры «Своя игра».
Паков дано несколько, они пронумерованы, и разобрать надо каждый — по отдельности,
как если бы он пришёл один. Пак с паком не смешивай: темы одного не влияют
ни на доли, ни на описание, ни на аудиторию другого.

Про КАЖДЫЙ пак делаются четыре работы, и все четыре — по его собственному списку тем.

${PACK_CONTEXT}
Название, теги и описание у каждого пака свои: подсказка от одного к соседнему
не относится никак.

ПЕРВОЕ — разбери темы пака по одной.
${THEME_RULES}

ВТОРОЕ — опиши весь пак одной короткой фразой (поле s): по ней человек поймёт,
что внутри. У каждой темы после тире идёт выжимка её содержимого: ответы
на вопросы и куски самих вопросов, через « / ». Именно она и говорит, о чём пак
на самом деле.
${SUMMARY_RULES}

ТРЕТЬЕ — назови целевую аудиторию всего пака: возраст и пол тех, кому он интересен.
${AUDIENCE_RULES}

ЧЕТВЁРТОЕ — назови язык, на котором пак написан (поле lg).
${LANGUAGE_RULES}

Ответь массивом JSON, по объекту на каждый пак, в том же порядке, в каком паки
даны. Поле p — номер пака (тот самый, под которым он дан), поле s — фраза про
весь пак, поля se, su и sk — она же на остальных языках, поля af, at и mp —
про его аудиторию, поле lg — его язык, поле t — массив, по объекту на каждую
тему этого пака, в том же порядке, в каком темы даны.

Не пропускай паки и не объединяй их: сколько паков дано, столько объектов
и должно быть в ответе, и у каждого — свои темы, все до последней.`;

const PACKS_SCHEMA = {
	type: 'ARRAY',
	items: {
		type: 'OBJECT',
		properties: {
			p: { type: 'INTEGER' },
			s: { type: 'STRING' },
			...SUMMARY_TRANSLATIONS,
			...AUDIENCE_FIELDS,
			t: SCHEMA,
		},
		required: ['p', 's', ...Object.keys(SUMMARY_TRANSLATIONS), 'af', 'at', 'mp', 'lg', 't'],
	},
};

/**
 * То же самое, что analyzePack, но сразу про несколько паков одним запросом.
 *
 * Ради чего. Скорость разбора упирается не в канал и не в размер ответа,
 * а в счёт запросов: бесплатный ключ даёт пятнадцать запросов в минуту и пятьсот
 * в сутки — и то и другое считает именно запросы, сколько бы тем в них ни уехало.
 * Пак за запрос означал ровно пятьсот паков в сутки и пятнадцать в минуту,
 * сколько работников ни поставь: общая очередь (см. takeTurn) всё равно
 * расставляет их по четыре секунды друг от друга.
 *
 * Поэтому паки едут пачкой. Пять паков в запросе — это те же пятьсот запросов
 * и две с половиной тысячи паков в сутки, и впятеро быстрее по минутам. Токенов
 * при этом тратится столько же: список тем у каждого пака свой и короче
 * не становится, а инструкция, наоборот, отправляется одна на всех вместо пяти.
 *
 * Что бывает не так. Ответ на пачку длиннее и потому чаще упирается в предел
 * длины: модель обрывается на середине — то на теме, то на целом паке. Это видно
 * (не хватает объекта или его тем), и такие паки переспрашиваются половинками
 * пачки, а в самом низу — по одному, обычным analyzePack. Разобранные в первом
 * же ответе паки при этом остаются разобранными и второй раз не спрашиваются.
 *
 * @param {Array<{name: string, themes: Array}>} packs
 * @returns {Promise<Array>} по ответу на пак, в том же порядке; поля — как у analyzePack
 */
export async function analyzePacks(packs) {
	if (packs.length === 0) {
		return [];
	}

	// Один пак — обычный запрос: у него и инструкция короче, и запасной путь свой
	if (packs.length === 1) {
		return [await analyzePack(packs[0])];
	}

	const half = async () => {
		const middle = Math.ceil(packs.length / 2);
		const head = await analyzePacks(packs.slice(0, middle));
		const tail = await analyzePacks(packs.slice(middle));

		return [...head, ...tail];
	};

	const list = packs.map((pack, index) => {
		const themes = pack.themes ?? [];
		return `Пак ${index}: «${pack.name ?? ''}»${packAbout(pack)}${themeLines(themes)}`;
	});

	let value = null;
	let queries = [];

	try {
		({ value, queries } = await ask(`${PACKS_INSTRUCTION}\n\n${list.join('\n\n')}`, PACKS_SCHEMA, { search: true }));
	} catch (error) {
		// Отвечать нечем — ключ, модель или кончившиеся лимиты: половинки получат
		// ровно тот же отказ, только вдвое дороже
		if (error.fatal === true) {
			throw error;
		}

		return half();
	}

	const answers = Array.isArray(value) ? value : [];
	const byPack = new Map();

	for (const answer of answers) {
		const index = Number(answer?.p);

		if (Number.isInteger(index) && packs[index] && !byPack.has(index)) {
			byPack.set(index, answer);
		}
	}

	const results = packs.map((pack, index) => {
		const themes = pack.themes ?? [];
		const answer = byPack.get(index);
		const marks = Array.isArray(answer?.t) ? answer.t : [];

		// Пака в ответе нет вовсе или его темы кончились раньше времени: ответ
		// оборвался. Досказать нечем — такой пак спрашивается заново
		if (!answer || marks.length < themes.length) {
			return null;
		}

		const collected = collectMarks(themes, marks);

		// Ответ про пак есть, а разобранных тем в нём нет: он не про этот пак.
		// Спрашиваем заново — по одному пак разбирается своими номерами тем,
		// и путать их там не с чем (см. alignAnswers)
		if (themes.length > 0 && marked(collected) === 0) {
			return null;
		}

		return {
			marks: collected,
			summary: cleanSummary(answer.s),
			translations: cleanTranslations(answer),
			audience: cleanAudience(answer),
			language: cleanLanguage(answer.lg),
			queries,
			split: false,
		};
	});

	const missing = results.filter(result => result === null).length;

	if (missing === 0) {
		return results;
	}

	// Не досталось ничего — пачка целиком не влезла: делим её пополам.
	// Досталось частью — переспрашиваем только недостающие: их заведомо меньше,
	// и деление на этом кончается
	if (missing === packs.length) {
		return half();
	}

	const rest = packs.filter((pack, index) => results[index] === null);
	const answered = await analyzePacks(rest);
	let next = 0;

	return results.map(result => result ?? answered[next++]);
}
