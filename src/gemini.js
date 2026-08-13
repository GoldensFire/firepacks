// Определение тематики тем через Gemini. Темы уходят пачками, ответ приходит строгим JSON.

import { config, EXCLUSIVE_TOPIC_KEYS } from './config.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Есть ли ключ. Без него шаг с тематиками просто пропускается. */
export function hasGemini() {
	return Boolean(config.geminiKey);
}

class GeminiError extends Error {
	constructor(message, status, options = {}) {
		super(message);
		this.name = 'GeminiError';
		this.status = status;
		/**
		 * Повторять бессмысленно: неверный ключ, неизвестная модель или кончившиеся
		 * лимиты. По этому признаку индексатор бросает шаг целиком, а не идёт
		 * с той же ошибкой по всем оставшимся пакам (см. quota).
		 */
		this.fatal = options.fatal ?? false;
		/** Лимиты кончились: ждать бесполезно до самой смены суток. */
		this.quota = options.quota ?? false;
		/** Через сколько миллисекунд Gemini разрешает повторить запрос, если сказал. */
		this.retryAfterMs = options.retryAfterMs ?? null;
	}
}

/**
 * Сколько Gemini просит подождать. При лимитах он присылает RetryInfo
 * («retryDelay»: «37s»), и это куда честнее нашей лесенки пауз.
 */
function retryDelayFrom(error) {
	for (const detail of error?.details ?? []) {
		const delay = /^(\d+(?:\.\d+)?)s$/.exec(String(detail.retryDelay ?? ''));

		if (delay) {
			return Math.round(Number(delay[1]) * 1000);
		}
	}

	return null;
}

async function call(path, options = {}) {
	if (!config.geminiKey) {
		throw new GeminiError('нет ключа: положите его в data/gemini-key.txt или в переменную GEMINI_API_KEY', 0, { fatal: true });
	}

	const response = await fetch(`${config.geminiEndpoint}/${path}`, {
		...options,
		headers: {
			'Content-Type': 'application/json',
			'x-goog-api-key': config.geminiKey,
			...options.headers,
		},
	});

	const text = await response.text();

	if (!response.ok) {
		let message = text.slice(0, 300);
		let retryAfterMs = null;

		try {
			const error = JSON.parse(text).error;
			message = error?.message ?? message;
			retryAfterMs = retryDelayFrom(error);
		} catch {
			// оставляем как есть
		}

		throw new GeminiError(message, response.status, { retryAfterMs });
	}

	return JSON.parse(text);
}

/** Список моделей, доступных ключу. */
export async function listModels() {
	const data = await call('models');

	return (data.models ?? [])
		.filter(model => (model.supportedGenerationMethods ?? []).includes('generateContent'))
		.map(model => ({ name: model.name.replace(/^models\//, ''), title: model.displayName }));
}

const INSTRUCTION = `Ты разбираешь темы из пакетов вопросов для игры «Своя игра».
Для каждой темы определи, о чём она, и выбери ровно одну категорию (поле c):

anime    — аниме, манга, японская анимация, персонажи и сэйю аниме
games    — компьютерные, мобильные, консольные и настольные игры, киберспорт, персонажи игр
movies   — игровое кино и сериалы: фильмы, актёры, режиссёры, экранизации, кадры и цитаты
cartoons — мультфильмы и мультсериалы, кроме японского аниме: Disney, Pixar, DreamWorks,
           советские и российские мультики, «Симпсоны», «Рик и Морти», мультперсонажи
other    — всё остальное: наука, история, география, спорт, мемы, эрудиция, общие знания

Отдельно отметь музыку (поле m): true, если тему отгадывают по музыке или песням —
опенинги, саундтреки, исполнители, альбомы, клипы, тексты песен. Иначе false.

Ещё назови франшизу темы — конкретное произведение или серию, которой тема
посвящена целиком, в двух написаниях: по-русски (поле f) и латиницей (поле fe,
ромадзи или английское название). «Наруто» / «Naruto», «Ведьмак» / «The Witcher»,
«Атака титанов» / «Shingeki no Kyojin», «Тетрадь смерти» / «Death Note».

Правила для f и fe:
- Франшиза называется только у категорий anime, games, movies, cartoons.
  У other оставляй обе строки пустыми.
- Оба написания — про одно и то же произведение. Если русского названия
  не существует, продублируй латинское в оба поля, и наоборот.
- Одна вселенная — одно название, всегда одинаковое: части, сезоны и спин-оффы
  сводятся к общему имени. «Ведьмак 3», «Ведьмак: Дикая охота» и книги о Геральте —
  всё это «Ведьмак»; «Наруто Шиппуден» — это «Наруто».
- Пиши в именительном падеже, без кавычек, без года и без номера части.
- Формат, площадка и жанр произведением не являются. «Аниме», «Манга», «Опенинги»,
  «Вокалоид», «Vocaloid», «Nightcore», «Саундтрек», «Кино» — это не франшизы,
  и писать их в f или fe нельзя ни при каких условиях: оставляй пустые строки.
- Тема охватывает много разных произведений («Аниме нулевых», «Лучшие игры года»,
  «Актёры Голливуда») — франшизы нет, оставь пустые строки.
- Не выдумывай: если по названию и ответам конкретное произведение не видно,
  оставь пустые строки. Молчание намного лучше догадки — неверная франшиза
  свяжет между собой посторонние темы и накрутит паку повторов, которых нет.

Правила:
- Музыка не отменяет категорию, а идёт вместе с ней: опенинги аниме — c=anime, m=true;
  саундтреки игр — c=games, m=true; песни из мультфильмов — c=cartoons, m=true;
  эстрада, рок, рэп и прочая музыка сама по себе — c=other, m=true.
- Аниме важнее мультфильмов: японская анимация — всегда anime, даже если это мультсериал.
- Ответы важнее названия темы: названия часто шуточные и ничего не значат.
- Если тема смешанная или непонятная — c=other. Не угадывай.
- Ответь массивом JSON, по объекту на каждую тему, в том же порядке.`;

const SCHEMA = {
	type: 'ARRAY',
	items: {
		type: 'OBJECT',
		properties: {
			i: { type: 'INTEGER' },
			c: { type: 'STRING', enum: EXCLUSIVE_TOPIC_KEYS },
			m: { type: 'BOOLEAN' },
			f: { type: 'STRING' },
			fe: { type: 'STRING' },
		},
		required: ['i', 'c', 'm', 'f', 'fe'],
	},
};

function buildPrompt(batch) {
	const lines = batch.map((theme, index) => {
		const media = theme.media ? ` [в теме много: ${theme.media}]` : '';
		const sample = theme.sample ? `\n   ответы: ${theme.sample}` : '';
		return `${index}. «${theme.name}»${media}${sample}`;
	});

	return `${INSTRUCTION}\n\nТемы:\n${lines.join('\n')}`;
}

/**
 * Как попросить модель не тратить время на размышления. Раскладка тем по
 * категориям — задача без рассуждений, а платить за них приходится.
 * У Gemini 2.x это thinkingBudget: 0, у Gemini 3 и новее — thinkingLevel: 'low'
 * (thinkingBudget там отвергается с невнятным «Request contains an invalid
 * argument», без единого слова про thinking).
 */
function thinkingConfig() {
	const version = Number.parseFloat(/gemini-(\d+(?:\.\d+)?)/.exec(config.geminiModel)?.[1] ?? '0');
	return version >= 3 ? { thinkingLevel: 'low' } : { thinkingBudget: 0 };
}

async function askOnce(prompt, schema, withThinking) {
	const body = {
		contents: [{ role: 'user', parts: [{ text: prompt }] }],
		generationConfig: {
			temperature: 0,
			responseMimeType: 'application/json',
			responseSchema: schema,
			...(withThinking ? {} : { thinkingConfig: thinkingConfig() }),
		},
	};

	const data = await call(`models/${config.geminiModel}:generateContent`, {
		method: 'POST',
		body: JSON.stringify(body),
	});

	const candidate = data.candidates?.[0];
	const text = (candidate?.content?.parts ?? []).map(part => part.text ?? '').join('');

	if (!text) {
		throw new GeminiError(`пустой ответ (${candidate?.finishReason ?? 'без причины'})`, 0);
	}

	return JSON.parse(text);
}

/**
 * Модель иногда не понимает thinkingConfig — тогда пробуем без него и запоминаем.
 * Про сам thinkingConfig в ответе может не быть ни слова (см. thinkingConfig),
 * поэтому поводом отказаться от него считаем любой первый 400.
 */
let allowThinkingOff = true;

/**
 * Сколько ждать после отказа по лимиту. Обычно Gemini сам говорит сколько
 * (RetryInfo), но иногда молчит — тогда лесенка пауз, ограниченная сверху:
 * ждать минутами по три раза на каждый пак дороже, чем бросить шаг.
 */
const MAX_QUOTA_WAIT_MS = 30_000;

async function ask(prompt, schema) {
	let lastError = null;

	for (let attempt = 1; attempt <= config.geminiRetries; attempt++) {
		try {
			return await askOnce(prompt, schema, !allowThinkingOff);
		} catch (error) {
			lastError = error;

			if (allowThinkingOff && error.status === 400) {
				allowThinkingOff = false;
				continue;
			}

			// Ключ или запрос неверны — повторять бессмысленно
			if (error.status === 400 || error.status === 401 || error.status === 403 || error.status === 404) {
				error.fatal = true;
				throw error;
			}

			// Кончились лимиты. Минутный отпускает через несколько секунд, дневной
			// не отпустит вовсе, а различить их по ответу нельзя. Поэтому пробуем
			// столько раз, сколько сказано в настройках, и если лимит так и не
			// отпустил — объявляем его кончившимся: дальше шаг бросается целиком,
			// а не идёт с той же ошибкой по всем оставшимся пакам.
			if (error.status === 429) {
				if (attempt < config.geminiRetries) {
					await sleep(Math.min(error.retryAfterMs ?? config.geminiDelayMs * attempt * 4, MAX_QUOTA_WAIT_MS));
					continue;
				}

				error.fatal = true;
				error.quota = true;
				throw error;
			}

			if (attempt < config.geminiRetries) {
				await sleep(config.geminiDelayMs * attempt * 2);
			}
		}
	}

	throw lastError;
}

async function askBatch(batch) {
	const parsed = await ask(buildPrompt(batch), SCHEMA);

	if (!Array.isArray(parsed)) {
		throw new GeminiError('ответ не является массивом', 0);
	}

	return parsed;
}

/**
 * Приводит название франшизы к тому виду, в каком его не стыдно показать.
 * Модель нет-нет да и вернёт «"Наруто"», «наруто (2002)» или «Наруто.» — а считать
 * повторы надо так, чтобы все три написания попали в одну кучу.
 */
function cleanFranchise(value) {
	const name = String(value ?? '')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/^[«"'(]+|[»"'.,)]+$/g, '')
		.replace(/\s*\(\d{4}\)$/, '')
		.trim();

	// «Нет», «неизвестно», «-» — способы модели сказать «франшизы тут нет»
	if (name.length < 2 || /^(нет|none|n\/a|неизвестно|разное|различные)$/i.test(name)) {
		return '';
	}

	return name.slice(0, 60);
}

/**
 * Раскладывает темы по категориям.
 * @param {Array<{key: string, name: string, sample: string, media: string}>} themes
 * @param {object} options onProgress — колбэк (сделано, всего)
 * @returns {Promise<Map<string, {category: string, music: boolean, franchise: string}>>} ключ темы -> разметка
 */
export async function classifyThemes(themes, options = {}) {
	const result = new Map();
	let done = 0;

	const process = async batch => {
		if (batch.length === 0) {
			return;
		}

		let answers;

		try {
			answers = await askBatch(batch);
		} catch (error) {
			// Ответ мог не влезть в лимит — делим пачку и пробуем ещё раз.
			// Но не тогда, когда отвечать уже нечем: на кончившихся лимитах
			// деление пополам только умножало запросы, каждый из которых заведомо
			// получит тот же отказ.
			if (batch.length > 1 && !error.fatal) {
				const middle = Math.ceil(batch.length / 2);
				await process(batch.slice(0, middle));
				await sleep(config.geminiDelayMs);
				await process(batch.slice(middle));
				return;
			}

			throw error;
		}

		for (const answer of answers) {
			const theme = batch[answer.i];

			if (theme && EXCLUSIVE_TOPIC_KEYS.includes(answer.c)) {
				// У «прочего» франшизы не бывает по условию задачи: если модель
				// всё же что-то придумала, это шум, а не повтор
				const other = answer.c === 'other';

				result.set(theme.key, {
					category: answer.c,
					music: answer.m === true,
					franchise: other ? '' : cleanFranchise(answer.f),
					// Второе написание нужно не для показа, а чтобы связать между собой
					// темы, названные по-разному (см. franchise.js)
					franchiseEn: other ? '' : cleanFranchise(answer.fe),
				});
			}
		}

		// Темы, по которым модель промолчала, считаем неопределёнными
		for (const theme of batch) {
			if (!result.has(theme.key)) {
				result.set(theme.key, { category: 'other', music: false, franchise: '', franchiseEn: '' });
			}
		}

		done += batch.length;

		if (options.onProgress) {
			options.onProgress(done, themes.length);
		}
	};

	for (let i = 0; i < themes.length; i += config.geminiBatchSize) {
		await process(themes.slice(i, i + config.geminiBatchSize));

		if (i + config.geminiBatchSize < themes.length) {
			await sleep(config.geminiDelayMs);
		}
	}

	return result;
}

const SUMMARY_INSTRUCTION = `Ты описываешь пакеты вопросов для игры «Своя игра».
Нужна одна короткая фраза, по которой человек поймёт, что внутри пака.

Тебе дают название пака, теги и список тем. У каждой темы после тире идёт
выжимка её содержимого: ответы на вопросы и куски самих вопросов, через « / ».
Именно она и говорит, о чём пак на самом деле.

Правила:
- Не длиннее 70 знаков, с большой буквы, без точки в конце.
- Суть определяй по выжимке — по ответам и текстам вопросов. Названия тем и пака
  в «Своей игре» сплошь шуточные и к содержимому отношения не имеют: тема
  «Мальчик, который выжил... на паре» — это Гарри Поттер, а не студенчество.
- Теги ставит автор, и ставит их наотмашь: они годятся как подсказка, но
  спорить с ответами не могут. Ответы важнее тегов, тегов важнее названия.
- Есть общий предмет — назови именно его: «Вселенная Гарри Поттера»,
  «Логотипы и слоганы компаний», «Аниме нулевых», «Российский рэп».
- Общего предмета нет — назови два-три главных направления через запятую,
  и бери те, которых в ответах больше всего: «Кино, музыка и советская эстрада».
- Не перечисляй темы подряд и не пиши «пак про» — сразу называй суть.
- Пиши по-русски.`;

const SUMMARY_SCHEMA = {
	type: 'OBJECT',
	properties: { s: { type: 'STRING' } },
	required: ['s'],
};

/**
 * Краткая суть пака одной строкой: «Вселенная Гарри Поттера», «Логотипы компаний».
 *
 * Модель смотрит не только на названия тем и теги, но и на выжимку содержимого
 * каждой темы — ответы и куски текстов вопросов (её собирает buildSample в siq.js).
 * Без неё описание получалось про названия, а названия тем в «Своей игре» шуточные
 * и о содержимом не говорят ничего.
 *
 * @param {{name: string, tags: string[], themes: Array<{name: string, sample: string}>}} pack
 * @returns {Promise<string>} описание или пустая строка, если сказать нечего
 */
export async function describePack(pack) {
	const themes = pack.themes.slice(0, config.summaryThemeLimit).map(theme => {
		const sample = theme.sample ? ` — ${theme.sample.slice(0, config.summarySampleLimit)}` : '';
		return `- ${theme.name}${sample}`;
	});

	if (themes.length === 0) {
		return '';
	}

	const tags = pack.tags?.length > 0 ? `\nТеги: ${pack.tags.join(', ')}` : '';
	const cut = pack.themes.length > themes.length ? `\n(и ещё ${pack.themes.length - themes.length} тем)` : '';
	const prompt = `${SUMMARY_INSTRUCTION}\n\nПак: «${pack.name}»${tags}\nТемы:\n${themes.join('\n')}${cut}`;

	const answer = await ask(prompt, SUMMARY_SCHEMA);

	// Модель нет-нет да и обернёт фразу в кавычки или закончит точкой
	return String(answer?.s ?? '')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/^[«"']|[»"']$/g, '')
		.replace(/\.$/, '')
		.slice(0, 120);
}
