// Определение тематики тем через Gemini. Темы уходят пачками, ответ приходит строгим JSON.

import { config, EXCLUSIVE_TOPIC_KEYS, OTHER_KINDS, OTHER_KIND_KEYS, GENRES, MUSIC_KEY, isGenre } from './config.js';
import { currentModel, modelInfo, noteRequest, noteQuotaHit, noteUnavailable, searchRefused, noteSearchRefused } from './models.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Есть ли ключ. Без него шаг с тематиками просто пропускается. */
export function hasGemini() {
	return Boolean(config.geminiKey);
}

/**
 * Модель этого запуска. По умолчанию та, что выбрана на странице обновления
 * (она лежит в базе), но ключ --model= перебивает выбор на один раз, не меняя
 * его для ночного обхода.
 */
let chosen = null;

export function useModel(id) {
	chosen = id || null;
}

export function activeModel() {
	return chosen ?? currentModel();
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
		/** Суточные лимиты кончились: ждать бесполезно до самой смены суток. */
		this.quota = options.quota ?? false;
		/** Через сколько миллисекунд Gemini разрешает повторить запрос, если сказал. */
		this.retryAfterMs = options.retryAfterMs ?? null;
		/** Суточный предел, названный самим Gemini в отказе. */
		this.dayLimit = options.dayLimit ?? null;
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

/**
 * Какой именно лимит кончился и чему он равен.
 *
 * Отказ 429 приходит на два разных повода, и путать их дорого. Минутный лимит
 * отпускает через десяток секунд — надо просто подождать. Суточный не отпустит
 * до полуночи в Калифорнии, и ждать его означает потерять ночь. Раньше различить
 * их было нечем, и всякий 429 после трёх попыток объявлялся концом суток.
 *
 * На самом деле Gemini говорит прямо: в подробностях отказа лежит QuotaFailure,
 * а в нём quotaId вида «GenerateRequestsPerDayPerProjectPerModel-FreeTier»
 * и quotaValue — то самое число, которого мы не знали. Отсюда же берётся точный
 * суточный предел модели (см. noteQuotaHit в models.js).
 *
 * @returns {{perDay: boolean, dayLimit: number|null}}
 */
function quotaFailureFrom(error) {
	let perDay = false;
	let dayLimit = null;

	for (const detail of error?.details ?? []) {
		for (const violation of detail.violations ?? []) {
			const id = String(violation.quotaId ?? '') + String(violation.quotaMetric ?? '');
			const value = Number(violation.quotaValue);

			if (/per_?day/i.test(id)) {
				perDay = true;

				if (Number.isFinite(value) && value > 0) {
					dayLimit = value;
				}
			}
		}
	}

	return { perDay, dayLimit };
}

/**
 * Общий на всех темп обращений к модели.
 *
 * Шаги теперь идут одновременно, и тематики с описаниями стучатся к Gemini
 * вдвоём, каждый ещё и несколькими работниками. Пауза «поспать после запроса»
 * такое не удерживает вовсе: считает она только своего работника, а лимит
 * у модели общий и минутный. Поэтому очередь одна на весь процесс: каждый
 * запрос занимает ближайшее свободное окошко, а окошки расставлены по минутному
 * пределу выбранной модели.
 */
let nextSlot = 0;

async function takeTurn() {
	const perMinute = modelInfo(activeModel()).rpm || 10;
	const gap = Math.max(config.geminiMinGapMs, Math.round(60_000 / perMinute));
	const now = Date.now();
	const at = Math.max(now, nextSlot);

	nextSlot = at + gap;

	if (at > now) {
		await sleep(at - now);
	}
}

/** Отодвигает очередь целиком: раз уж уперлись в минутный лимит, ждать всем. */
function holdBack(ms) {
	nextSlot = Math.max(nextSlot, Date.now() + ms);
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
		let quota = { perDay: false, dayLimit: null };

		try {
			const error = JSON.parse(text).error;
			message = error?.message ?? message;
			retryAfterMs = retryDelayFrom(error);
			quota = quotaFailureFrom(error);
		} catch {
			// оставляем как есть
		}

		throw new GeminiError(message, response.status, {
			retryAfterMs,
			quota: quota.perDay,
			dayLimit: quota.dayLimit,
		});
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

/** Жанры одной тематики в строку: «isekai — исекай, mecha — меха, …». */
const genreList = topic => Object.entries(GENRES[topic].list)
	.map(([key, name]) => `${key} — ${name}`)
	.join(', ');

/**
 * Жанры всех тематик, кроме музыки: у неё свой вопрос («по музыке отгадывают»),
 * и спрашивается она не по категории темы, а по признаку m.
 */
const GENRE_LIST = Object.keys(GENRES)
	.filter(topic => topic !== MUSIC_KEY)
	.map(topic => `${topic}: ${genreList(topic)}`)
	.join('\n');

/**
 * Куда смотреть за тем, чего модель не знает.
 *
 * Половина паков написана про то, что вышло позже, чем кончились данные модели,
 * а вторая половина — про то, что и в свежих данных лежит в одном экземпляре:
 * ранобэ без экранизации, инди-игра, сериал одной страны. Раньше на таких темах
 * модель угадывала по звучанию названия — и «Sousou no Frieren» становилась игрой,
 * а «Дюна» то книгой, то фильмом наугад. Поэтому ей дан поиск (см. groundingTools),
 * а здесь сказано, где искать: без этого она гуглит само название темы, а названия
 * тем в «Своей игре» шуточные и в поиске не значат ничего.
 */
const SOURCES = `Чего не знаешь — посмотри, а не угадывай:
- Тебе разрешено открывать страницы в интернете (url_context), а иногда и искать
  (google_search). Незнакомое название, спор «это аниме или игра», два разных
  произведения под одним именем, вышедшее после того, как кончились твои
  данные, — всё это поводы посмотреть, а не гадать.
- Смотри не по названию темы, а по тому, что за ней стоит: названия тем в «Своей
  игре» шуточные и в поиске не значат ничего. Ищи по ответам — по именам,
  которые в них названы.
- Адреса, которые точно открываются, — подставь свой запрос вместо ЗАПРОС:
  веб-поиск: https://duckduckgo.com/html/?q=ЗАПРОС
  Википедия: https://ru.wikipedia.org/w/index.php?search=ЗАПРОС
  К запросу добавляй слово, отсекающее лишнее: «аниме», «игра», «фильм», «книга».
- Дальше иди по ссылкам из найденного, по своему делу: аниме и манга —
  shikimori.one (у него есть и открытое API: https://shikimori.one/api/animes?search=…),
  myanimelist.net, anilist.co; кино и сериалы — Кинопоиск, IMDb, Википедия;
  игры — Steam, IGDB, вики на Fandom; книги — LiveLib, «Фантлаб», Goodreads.
  Какой-то из сайтов не открылся — это обычное дело, возьми другой.
- Выясняй не только то, что произведение существует, но и то, чем оно является:
  аниме, игра, фильм, книга. Ровно из этого и следует категория.
- Смотри только непонятное, и лучше одним заходом на весь пак, а не по заходу
  на тему. Про то, что знаешь и так, ходить никуда не надо.
- Ничего не нашлось — отвечай пустыми строками, как и велено ниже. Выдумка хуже
  молчания.`;

const THEME_RULES = `Для каждой темы определи, о чём она, и выбери ровно одну категорию (поле c):

anime    — аниме, манга, японская анимация, персонажи и сэйю аниме
games    — компьютерные, мобильные, консольные и настольные игры, киберспорт, персонажи игр
movies   — игровое кино и сериалы: фильмы, актёры, режиссёры, экранизации, кадры и цитаты
cartoons — мультики и мультсериалы, кроме японского аниме: Disney, Pixar, DreamWorks,
           советские и российские мультики, «Симпсоны», «Рик и Морти», мультперсонажи
books    — книги и то, что живёт на бумаге: романы, писатели, поэзия, литературные
           герои и сюжеты, комиксы и графические романы, манга без экранизации
other    — всё остальное: наука, история, география, спорт, мемы, эрудиция, общие знания

Отдельно отметь музыку (поле m): true, если тему отгадывают по музыке или песням —
опенинги, саундтреки, исполнители, альбомы, клипы, тексты песен. Иначе false.

Если категория other, назови ещё и вид «прочего» (поле k) — одно значение из списка:
${OTHER_KIND_KEYS.map(key => `${key} — ${OTHER_KINDS[key]}`).join('\n')}
Ничего из списка не подходит или категория не other — оставь пустую строку.

Назови жанр темы (поле g) — одно значение из списка своей категории:
${GENRE_LIST}
У категории other жанра нет: там оставь пустую строку.

Если тема музыкальная (m=true), назови ещё и жанр самой музыки (поле gm) —
одно значение из списка:
${genreList(MUSIC_KEY)}
Тема немузыкальная — пустая строка.

Жанр всегда один, а подходят обычно несколько: бери тот, что выше в списке.
Списки нарочно составлены по старшинству, от самого говорящего жанра к самому
общему. «Re:Zero» — это и фэнтези, и драма, и романтика, но прежде всего isekai,
и потому isekai стоит первым; «Тетрадь смерти» — detective, а не drama.
Жанра по теме не видно или ничего из списка не подходит — пустая строка.
Выдуманный жанр хуже пустой строки: по этим ответам считаются доли пака.

Ещё назови предмет темы — то одно, чему тема посвящена целиком, в двух
написаниях: по-русски (поле f) и латиницей (поле fe, ромадзи или английское
название). У категорий anime, games, movies, cartoons это произведение или серия:
«Наруто» / «Naruto», «Ведьмак» / «The Witcher», «Атака титанов» / «Shingeki no
Kyojin». У other — область, которой тема посвящена целиком: «Футбол» / «Football»,
«Вархаммер» / «Warhammer», «Вторая мировая война» / «World War II», «Химия» /
«Chemistry», «Шахматы» / «Chess».

Правила для f и fe:
- Оба написания — про одно и то же. Если русского названия не существует,
  продублируй латинское в оба поля, и наоборот.
- Одна вселенная — одно название, всегда одинаковое: части, сезоны и спин-оффы
  сводятся к общему имени. «Ведьмак 3», «Ведьмак: Дикая охота» и книги о Геральте —
  всё это «Ведьмак»; «Наруто Шиппуден» — это «Наруто».
- Пиши в именительном падеже, без кавычек, без года и без номера части.
- Формат, площадка и жанр предметом не являются. «Аниме», «Манга», «Опенинги»,
  «Вокалоид», «Vocaloid», «Nightcore», «Саундтрек», «Кино» — это не предмет,
  и писать их в f или fe нельзя ни при каких условиях: оставляй пустые строки.
- «Общие знания», «Эрудиция», «Разное», «Логика», «Викторина» — это тоже не
  предмет, а его отсутствие: оставляй пустые строки.
- Предмет должен быть узкий. «Спорт», «История», «Наука», «География» слишком
  широки — их называй, только если уже́ никак: «Футбол», «Вторая мировая война»,
  «Астрономия», «Столицы» лучше в каждом случае, когда подходят.
- Тема охватывает много разного («Аниме нулевых», «Лучшие игры года», «Актёры
  Голливуда», «Всё обо всём») — предмета нет, оставь пустые строки.
- Не выдумывай: если по названию и ответам одного предмета не видно, оставь
  пустые строки. Молчание намного лучше догадки — неверный предмет свяжет между
  собой посторонние темы и накрутит паку повторов, которых нет.

Правила:
- Музыка не отменяет категорию, а идёт вместе с ней: опенинги аниме — c=anime, m=true;
  саундтреки игр — c=games, m=true; песни из мультфильмов — c=cartoons, m=true;
  эстрада, рок, рэп и прочая музыка сама по себе — c=other, m=true.
- Аниме важнее мультиков: японская анимация — всегда anime, даже если это мультсериал.
- Экранизация решается по тому, о чём спрашивают: кадры, актёры и реплики из фильма —
  movies; сюжет, герои и текст книги — books. «Гарри Поттер» бывает и тем, и другим.
- Предмет (f и fe) называй у КАЖДОЙ темы, где он виден, а не только у явных: по нему
  считаются повторы пака — то, к чему он возвращается снова и снова. Промолчав там,
  где произведение названо прямо в ответах, ты прячешь повтор, которого не увидит никто.
- Ответы важнее названия темы: названия часто шуточные и ничего не значат.
- Если тема смешанная или непонятная — c=other. Не угадывай.

${SOURCES}`;

const INSTRUCTION = `Ты разбираешь темы из пакетов вопросов для игры «Своя игра».
${THEME_RULES}

Ответь массивом JSON, по объекту на каждую тему, в том же порядке.`;

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
			// Вид «прочего». Перечислением (enum) не ограничен нарочно: пустая строка
			// здесь законный ответ — «вида нет», — а перечисление, в котором есть
			// пустая строка, часть моделей отвергает целиком, невнятным 400 на весь
			// запрос. Проверка всё равно наша: чужое слово отсеется при разборе ответа
			k: { type: 'STRING' },
			// Жанр темы и жанр её музыки. Перечислением не ограничены по той же
			// причине, что и вид «прочего»: пустая строка здесь законный ответ,
			// а списки к тому же разные у каждой категории — одним enum их не выразить
			g: { type: 'STRING' },
			gm: { type: 'STRING' },
		},
		required: ['i', 'c', 'm', 'f', 'fe', 'k', 'g', 'gm'],
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
	const version = Number.parseFloat(/gemini-(\d+(?:\.\d+)?)/.exec(activeModel())?.[1] ?? '0');
	return version >= 3 ? { thinkingLevel: 'low' } : { thinkingBudget: 0 };
}

/**
 * Поиск и чтение страниц, которыми модель дополняет то, чего не знает сама.
 *
 * Вещи это разные, и дают их по-разному. `urlContext` — открыть названный адрес;
 * он есть у бесплатного ключа и работает всегда. `googleSearch` — настоящий поиск
 * с грундингом; у бесплатного ключа его нет вовсе, и узнаётся это не отказом
 * «нельзя», а внезапным 429 «кончилась квота» на первом же запросе — при том, что
 * суточная квота самой модели цела и не тронута. Принять этот отказ за конец
 * суток означало бы остановить весь ночной обход из-за инструмента, которого
 * у нас и так нет (см. ask: 429 при поиске сначала выключает поиск, а не сутки).
 *
 * Оттого и адреса в SOURCES выбраны так, чтобы поиск был не нужен: страница
 * выдачи DuckDuckGo и поиск по Википедии открываются самим url_context, и модель
 * ищет через них, даже когда googleSearch недоступен.
 *
 * Все три выключателя щёлкаются сами, по первому отказу, и на весь запуск.
 */
let searchOff = searchRefused();
let browseOff = false;
let searchSchemaOff = false;

/** Пользуемся ли внешними источниками в этом запросе. */
const grounded = search => Boolean(search) && config.geminiSearch !== false && !(searchOff && browseOff);

/** Инструменты этого запроса — из тех, что ещё не выключились отказом. */
function groundingTools() {
	const tools = [];

	if (!searchOff) {
		tools.push({ googleSearch: {} });
	}

	if (!browseOff) {
		tools.push({ urlContext: {} });
	}

	return tools;
}

/** Куда модель ходила: и запросы в поиск, и открытые страницы — одним списком для лога. */
function groundingTrace(candidate) {
	const queries = candidate?.groundingMetadata?.webSearchQueries ?? [];
	const urls = (candidate?.urlContextMetadata?.urlMetadata ?? [])
		.filter(item => item.urlRetrievalStatus === 'URL_RETRIEVAL_STATUS_SUCCESS')
		.map(item => item.retrievedUrl);

	return [...queries, ...urls];
}

/**
 * Ответ без схемы приходит обычным текстом, и модель нет-нет да и обернёт его
 * в ```json. Достаём из строки первый же объект или массив.
 */
function parseLoose(text) {
	const clean = text.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();

	try {
		return JSON.parse(clean);
	} catch {
		// оставляем как есть: попробуем вырезать из середины
	}

	const start = clean.search(/[[{]/);
	const end = Math.max(clean.lastIndexOf(']'), clean.lastIndexOf('}'));

	if (start === -1 || end <= start) {
		throw new GeminiError(`ответ не разобрать как JSON: ${clean.slice(0, 200)}`, 0);
	}

	return JSON.parse(clean.slice(start, end + 1));
}

/**
 * @returns {Promise<{value: any, queries: string[]}>} разобранный ответ и то,
 *   что модель искала в поиске: по этому списку видно, гуглит ли она нужное
 */
async function askOnce(prompt, schema, options = {}) {
	const search = grounded(options.search);
	const withSchema = Boolean(schema) && !(search && searchSchemaOff);

	const body = {
		contents: [{
			role: 'user',
			parts: [{
				text: withSchema
					? prompt
					: `${prompt}\n\nОтветь одним только JSON — без пояснений до и после и без разметки \`\`\`.`,
			}],
		}],
		generationConfig: {
			temperature: 0,
			...(withSchema ? { responseMimeType: 'application/json', responseSchema: schema } : {}),
			...(options.withThinking ? {} : { thinkingConfig: thinkingConfig() }),
		},
		...(search ? { tools: groundingTools() } : {}),
	};

	const model = activeModel();

	await takeTurn();

	// Расход отмечается до ответа, а не после: в лимит запрос попадает уже тем,
	// что ушёл, и отказ по нему — такая же потраченная попытка, как удача
	noteRequest(model);

	const data = await call(`models/${model}:generateContent`, {
		method: 'POST',
		body: JSON.stringify(body),
	});

	const candidate = data.candidates?.[0];
	const text = (candidate?.content?.parts ?? []).map(part => part.text ?? '').join('');

	if (!text) {
		throw new GeminiError(`пустой ответ (${candidate?.finishReason ?? 'без причины'})`, 0);
	}

	return {
		value: withSchema ? JSON.parse(text) : parseLoose(text),
		queries: groundingTrace(candidate),
	};
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

async function ask(prompt, schema, options = {}) {
	let lastError = null;

	for (let attempt = 1; attempt <= config.geminiRetries; attempt++) {
		try {
			return await askOnce(prompt, schema, { ...options, withThinking: !allowThinkingOff });
		} catch (error) {
			lastError = error;

			// Попытки, потраченные на то, чтобы выяснить, чего эта модель не умеет,
			// в счёт повторов не идут: каждый выключатель щёлкается один раз за
			// запуск, а вот повторов на настоящую ошибку иначе не осталось бы вовсе
			if ((error.status === 400 || error.status === 429) && grounded(options.search)) {
				// Поиска у бесплатного ключа нет, и говорит он об этом отказом
				// «кончилась квота» — при нетронутой суточной квоте самой модели.
				// Поэтому первым делом снимается он: если дело и вправду в сутках,
				// тот же отказ придёт и без поиска, и разберётся с ним общий разбор
				// 429 ниже. Иначе одного этого хватало, чтобы объявить ночь
				// законченной, не разметив ни единого пака.
				if (!searchOff) {
					searchOff = true;
					noteSearchRefused();
					attempt--;
					continue;
				}

				if (error.status === 400 && !searchSchemaOff && schema) {
					searchSchemaOff = true;
					attempt--;
					continue;
				}

				if (error.status === 400) {
					browseOff = true;
					attempt--;
					continue;
				}
			}

			if (allowThinkingOff && error.status === 400) {
				allowThinkingOff = false;
				attempt--;
				continue;
			}

			// Ключ или запрос неверны — повторять бессмысленно
			if (error.status === 400 || error.status === 401 || error.status === 403 || error.status === 404) {
				// Модель закрыли для новых ключей — по списку доступных этого не видно,
				// узнаётся только так. Запоминаем, чтобы на странице обновления она
				// была видна закрытой, а не выглядела рабочей до следующей ночи
				if (/no longer available|is not found|not supported|has been deprecated/i.test(error.message)) {
					noteUnavailable(activeModel(), error.message);
				}

				error.fatal = true;
				throw error;
			}

			// Кончились лимиты. Какие именно — сказано в самом отказе (см.
			// quotaFailureFrom): суточный не отпустит до полуночи в Калифорнии,
			// и ждать его бессмысленно — шаг бросается сразу, вместе с ним
			// запоминается названный предел. Минутный отпускает через десяток
			// секунд: отодвигаем общую очередь и пробуем снова.
			if (error.status === 429) {
				if (error.quota) {
					noteQuotaHit(activeModel(), error.dayLimit);
					error.fatal = true;
					throw error;
				}

				const wait = Math.min(error.retryAfterMs ?? config.geminiDelayMs * attempt * 4, MAX_QUOTA_WAIT_MS);
				holdBack(wait);

				if (attempt < config.geminiRetries) {
					await sleep(wait);
					continue;
				}

				// Про какой лимит речь, Gemini так и не сказал. Считаем суточным:
				// три отказа подряд с ожиданием — это уже не минутная заминка
				noteQuotaHit(activeModel());
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
	// Поиск нужен именно здесь: категория темы и есть тот ответ, ради которого
	// стоит сходить на shikimori — «это аниме или игра» по названию не видно
	const { value } = await ask(buildPrompt(batch), SCHEMA, { search: true });

	if (!Array.isArray(value)) {
		throw new GeminiError('ответ не является массивом', 0);
	}

	return value;
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

/** Разметка темы, про которую модель ничего не сказала. */
const UNMARKED = {
	category: 'other',
	music: false,
	franchise: '',
	franchiseEn: '',
	kind: '',
	genre: '',
	musicGenre: '',
};

/**
 * Раскладывает ответы модели по ключам тем и отсеивает всё, чего в списках нет.
 *
 * Вынесено отдельно, потому что ответ про темы приходит двумя путями: своим
 * запросом (classifyThemes) и вместе с описанием пака одним запросом на всё
 * (analyzePack). Проверять чужие слова оба должны совершенно одинаково.
 *
 * @param {Array} batch темы в том порядке, в каком они уехали к модели
 * @param {Array} answers объекты ответа
 * @param {Map} result куда складывать
 */
function collectMarks(batch, answers, result = new Map()) {
	for (const answer of answers) {
		const theme = batch[answer?.i];

		if (theme && EXCLUSIVE_TOPIC_KEYS.includes(answer.c)) {
			result.set(theme.key, {
				category: answer.c,
				music: answer.m === true,
				// Предмет спрашивается у всех категорий, включая «прочее»: пак
				// целиком про футбол или про Вархаммер — такой же пак про одно,
				// как аниме-пак про «Наруто», и раньше он не получал ничего
				franchise: cleanFranchise(answer.f),
				// Второе написание нужно не для показа, а чтобы связать между собой
				// темы, названные по-разному (см. franchise.js)
				franchiseEn: cleanFranchise(answer.fe),
				// Вид «прочего»: чем эта общая куча оказалась на деле — стримерами,
				// историей, спортом. У остальных категорий вида нет и быть не должно
				kind: answer.c === 'other' && OTHER_KIND_KEYS.includes(answer.k) ? answer.k : '',
				// Жанр внутри тематики: чем один аниме-пак отличается от другого.
				// Годится только жанр из списка своей категории — «detective»
				// у категории games означал бы, что модель ответила невпопад
				genre: isGenre(answer.c, answer.g) ? answer.g : '',
				// Жанр музыки спрашивается отдельно и живёт отдельно: тема
				// с опенингами — это и аниме (genre), и анисонг (musicGenre)
				musicGenre: answer.m === true && isGenre(MUSIC_KEY, answer.gm) ? answer.gm : '',
			});
		}
	}

	// Темы, по которым модель промолчала, считаем неопределёнными
	for (const theme of batch) {
		if (!result.has(theme.key)) {
			result.set(theme.key, { ...UNMARKED });
		}
	}

	return result;
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

			// Ответ пришёл короче вопроса: модель уперлась в предел длины ответа
			// и оборвалась на середине списка. Прежде это молчание засчитывалось
			// как «тема ни о чём» (см. ниже) — то есть пак, у которого не влезла
			// половина тем, честно получал сорок процентов «прочего» и становился
			// солянкой из ничего. Заметить это можно только здесь и только так:
			// ответ при этом совершенно правильный, просто неполный.
			if (answers.length < batch.length && batch.length > 1) {
				throw new GeminiError(`ответ оборван: ${answers.length} тем из ${batch.length}`, 0);
			}
		} catch (error) {
			// Ответ мог не влезть в лимит — делим пачку и пробуем ещё раз.
			// Но не тогда, когда отвечать уже нечем: на кончившихся лимитах
			// деление пополам только умножало запросы, каждый из которых заведомо
			// получит тот же отказ.
			if (batch.length > 1 && !error.fatal) {
				const middle = Math.ceil(batch.length / 2);
				await process(batch.slice(0, middle));
				await process(batch.slice(middle));
				return;
			}

			throw error;
		}

		collectMarks(batch, answers, result);

		done += batch.length;

		if (options.onProgress) {
			options.onProgress(done, themes.length);
		}
	};

	// Пауз между пачками здесь больше нет: темп держит общая очередь запросов
	// (см. takeTurn), и она считает всех сразу, а не каждого работника по себе
	for (let i = 0; i < themes.length; i += config.geminiBatchSize) {
		await process(themes.slice(i, i + config.geminiBatchSize));
	}

	return result;
}

const SUMMARY_RULES = `Правила:
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

/**
 * Кому этот пак: возраст и пол тех, кому он интересен.
 *
 * Спрашивается вместе с описанием и по тому же списку тем — это ещё одна вещь
 * про весь пак целиком, а не про отдельную тему, и отдельного запроса она
 * не стоит (суточный лимит считает запросы, см. analyzePack).
 *
 * Это не статистика игроков и не может ею быть: сколько лет тем, кто запускал
 * пак, не знает никто. Это оценка по содержимому — по годам вышедших игр
 * и фильмов, по интернет-культуре, по тому, школьная это программа или взрослая
 * эрудиция. Ровно так её и надо читать на карточке.
 */
const AUDIENCE_RULES = `Правила:
- Возраст называй промежутком в годах: нижняя граница — поле af, верхняя — at.
  Промежуток должен быть узким, лет в семь-десять: «18–25», «25–35», «12–18».
  «10–60» не говорит ничего и потому не годится.
- Доля мужчин — поле mp, целые проценты. Женщины — всё остальное до ста,
  называть их отдельно не надо.
- Суди по содержимому: по названиям тем, текстам вопросов и ответам. Картинок,
  видео и звука из пака тебе не показывают, и судить по ним нельзя; по тому, как
  пак выглядит, — тоже.
- Гляди на годы вышедших игр, фильмов и музыки, на интернет-культуру, на общую
  направленность: видеоигры, киберспорт, спорт, аниме, музыка, кино и сериалы,
  технологии, литература, школьная программа, взрослая эрудиция.
- Оценивай весь пак целиком, а не отдельную тему: одна тема про аниме
  не делает аниме-паком пак про историю.
- Не выдумывай того, чего в паке нет. Но и не отказывайся: даже когда трудно,
  назови самое вероятное — пустых значений здесь не бывает.`;

const SUMMARY_INSTRUCTION = `Ты описываешь пакеты вопросов для игры «Своя игра».
Работы две, и делаются они по одному и тому же списку тем.

Тебе дают название пака, теги и список тем. У каждой темы после тире идёт
выжимка её содержимого: ответы на вопросы и куски самих вопросов, через « / ».
Именно она и говорит, о чём пак на самом деле.

ПЕРВОЕ — опиши весь пак одной короткой фразой (поле s): по ней человек поймёт,
что внутри.
${SUMMARY_RULES}

ВТОРОЕ — назови целевую аудиторию пака: возраст и пол тех, кому он интересен.
${AUDIENCE_RULES}`;

const AUDIENCE_FIELDS = {
	af: { type: 'INTEGER' },
	at: { type: 'INTEGER' },
	mp: { type: 'INTEGER' },
};

const SUMMARY_SCHEMA = {
	type: 'OBJECT',
	properties: { s: { type: 'STRING' }, ...AUDIENCE_FIELDS },
	required: ['s', 'af', 'at', 'mp'],
};

/** Крайние значения, за которыми ответ модели считается промахом, а не оценкой. */
const AGE_MIN = 6;
const AGE_MAX = 70;

/**
 * Проверяет возраст и пол, названные моделью.
 *
 * Всё, что не разобралось, обнуляется целиком: половина оценки — «возраст есть,
 * пола нет» — на карточке не значит ничего, а место занимает.
 *
 * @returns {{from: number, to: number, male: number}|null}
 */
function cleanAudience(answer) {
	const from = Math.round(Number(answer?.af));
	const to = Math.round(Number(answer?.at));
	const male = Math.round(Number(answer?.mp));

	if (![from, to, male].every(Number.isFinite)) {
		return null;
	}

	if (from < AGE_MIN || to > AGE_MAX || from > to || male < 0 || male > 100) {
		return null;
	}

	return { from, to, male };
}

/**
 * Краткая суть пака одной строкой: «Вселенная Гарри Поттера», «Логотипы компаний».
 *
 * Модель смотрит не только на названия тем и теги, но и на выжимку содержимого
 * каждой темы — ответы и куски текстов вопросов (её собирает buildSample в siq.js).
 * Без неё описание получалось про названия, а названия тем в «Своей игре» шуточные
 * и о содержимом не говорят ничего.
 *
 * Заодно тем же запросом спрашивается целевая аудитория пака (см. AUDIENCE_RULES):
 * вопрос задаётся по тому же списку тем, и отдельного запроса он не стоит.
 *
 * @param {{name: string, tags: string[], themes: Array<{name: string, sample: string}>}} pack
 * @returns {Promise<{summary: string, audience: {from: number, to: number, male: number}|null}>}
 *   описание (пустая строка, если сказать нечего) и оценка аудитории
 */
export async function describePack(pack) {
	const themes = pack.themes.slice(0, config.summaryThemeLimit).map(theme => {
		const sample = theme.sample ? ` — ${theme.sample.slice(0, config.summarySampleLimit)}` : '';
		return `- ${theme.name}${sample}`;
	});

	// Тем нет вовсе — спрашиваем всё равно, по названию и тегам. Пак без разобранных
	// тем ничем не заслужил остаться единственным без описания, а сказать по одному
	// названию модели чаще всего есть что; не найдёт смысла — вернёт пустую строку.
	if (themes.length === 0 && !pack.name) {
		return { summary: '', audience: null };
	}

	const cut = pack.themes.length > themes.length ? `\n(и ещё ${pack.themes.length - themes.length} тем)` : '';
	const list = themes.length > 0
		? `\nТемы:\n${themes.join('\n')}${cut}`
		: '\n(тем в паке разобрать не удалось: суди по названию и тегам, а не найдёшь смысла — верни пустую строку)';
	const prompt = `${SUMMARY_INSTRUCTION}\n\nПак: «${pack.name}»${packTags(pack)}${list}`;

	const { value } = await ask(prompt, SUMMARY_SCHEMA);

	return { summary: cleanSummary(value?.s), audience: cleanAudience(value) };
}

/** Теги пака строкой для запроса — одинаково у обоих способов спросить. */
const packTags = pack => (pack.tags?.length > 0 ? `\nТеги: ${pack.tags.join(', ')}` : '');

/** Модель нет-нет да и обернёт фразу в кавычки или закончит точкой. */
function cleanSummary(value) {
	return String(value ?? '')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/^[«"']|[»"']$/g, '')
		.replace(/\.$/, '')
		.slice(0, 120);
}

// ————— всё про пак одним запросом —————

const ANALYZE_INSTRUCTION = `Ты разбираешь пакет вопросов для игры «Своя игра».
Работы три, и делаются они за один раз, по одному и тому же списку тем.

ПЕРВОЕ — разбери темы пака по одной.
${THEME_RULES}

ВТОРОЕ — опиши весь пак одной короткой фразой (поле s): по ней человек поймёт,
что внутри. У каждой темы после тире идёт выжимка её содержимого: ответы
на вопросы и куски самих вопросов, через « / ». Именно она и говорит, о чём пак
на самом деле.
${SUMMARY_RULES}

ТРЕТЬЕ — назови целевую аудиторию всего пака: возраст и пол тех, кому он интересен.
${AUDIENCE_RULES}

Ответь одним объектом JSON: поле s — фраза про весь пак, поля af, at и mp —
про его аудиторию, поле t — массив, по объекту на каждую тему, в том же порядке,
в каком темы даны.`;

const ANALYZE_SCHEMA = {
	type: 'OBJECT',
	properties: {
		s: { type: 'STRING' },
		...AUDIENCE_FIELDS,
		t: SCHEMA,
	},
	required: ['s', 'af', 'at', 'mp', 't'],
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
 * @param {{name: string, tags: string[], themes: Array}} pack темы из listThemes
 * @returns {Promise<{marks: Map, summary: string, audience: object|null, queries: string[], split: boolean}>}
 */
export async function analyzePack(pack) {
	const themes = pack.themes ?? [];
	const list = themes.length > 0
		? `\n\nТемы:\n${themes.map((theme, index) => {
			const media = theme.media ? ` [в теме много: ${theme.media}]` : '';
			const sample = theme.sample ? `\n   ответы: ${theme.sample}` : '';
			return `${index}. «${theme.name}»${media}${sample}`;
		}).join('\n')}`
		: '\n\n(тем в паке разобрать не удалось: t оставь пустым массивом, а описание составь '
			+ 'по названию и тегам — не найдёшь смысла, верни пустую строку)';

	const prompt = `${ANALYZE_INSTRUCTION}\n\nПак: «${pack.name ?? ''}»${packTags(pack)}${list}`;

	try {
		const { value, queries } = await ask(prompt, ANALYZE_SCHEMA, { search: true });
		const answers = Array.isArray(value?.t) ? value.t : [];

		// Ответ короче списка тем — модель уперлась в предел длины и оборвалась
		// на середине. Молчание про хвост тем засчиталось бы как «прочее»,
		// и пак получил бы доли из ничего (см. classifyThemes)
		if (answers.length < themes.length) {
			throw new GeminiError(`ответ оборван: ${answers.length} тем из ${themes.length}`, 0);
		}

		return {
			marks: collectMarks(themes, answers),
			summary: cleanSummary(value?.s),
			audience: cleanAudience(value),
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
		const { summary, audience } = await describePack({ ...pack, themes });

		return { marks, summary, audience, queries: [], split: true, reason: error.message };
	}
}
