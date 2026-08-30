// Модели Gemini: какие годятся для разбора, чем отличаются и сколько запросов
// к каждой осталось на сегодня.
//
// Зачем это отдельным файлом. Модель у ключа не одна, и выбор между ними —
// не вкусовщина, а расчёт: слабая размечает тысячу паков за ночь и ошибается
// в мелочах, сильная разбирает два десятка в сутки, зато почти не мажет. Обычный
// порядок работы отсюда и следует: сначала пройти всю базу слабой, потом день
// за днём переспрашивать самое важное сильной (см. --upgrade в indexer.js).
//
// Чтобы так можно было работать, нужно знать две вещи: чем размечен каждый пак
// (колонки topics_model и summary_model) и сколько запросов к модели ещё можно
// сделать сегодня. Второе Gemini не сообщает никак — ни отдельным методом,
// ни заголовком в ответе. Единственный способ узнать предел — упереться в него
// и прочитать отказ. Поэтому расход считается здесь, у себя: каждый запрос
// отмечается в gemini_usage, а названный в отказе предел запоминается
// в gemini_limits и дальше показывается как точный.

import { db, getSetting, setSetting } from './db.js';
import { config } from './config.js';

/**
 * Модели, которыми имеет смысл размечать паки.
 *
 * Список не автоматический нарочно. Ключу доступны и рисовалки картинок,
 * и озвучка, и робототехника — выбирать разметчика из четырёх десятков названий,
 * где половина не умеет отвечать словами, не должен никто.
 *
 * `rank` — сила модели, по ней считается, что чем переспрашивать: паки,
 * размеченные моделью с меньшим рангом, можно отдать той, что выше.
 *
 * `rpd` и `rpm` — суточный и минутный пределы бесплатного ключа. Сверены с панелью
 * лимитов Google 13 августа 2026, и расклад там простой: у обеих Flash-Lite —
 * 15 запросов в минуту и 500 в сутки, у всех прочих Flash — 5 в минуту и 20 в сутки.
 *
 * `tpm` — третий предел, токены в минуту: 250 тысяч у всех. Раньше он здесь
 * не записывался вовсе — пачка из пяти паков весила тысяч десять токенов, и до
 * четверти миллиона было как до луны. Теперь пачка набирается по вопросам
 * (см. analyzeQuestionBatch в config.js) и весит втрое-вчетверо больше, так что
 * предел этот стал настоящим: очередь запросов считает и его (см. takeTurn
 * в src/gemini/api.js), иначе крупные пачки упирались бы в него раньше суточного.
 *
 * Числа всё равно живут своей жизнью: Google меняет их без объявления, а на платном
 * ключе они другие вовсе. Поэтому это предположение до первого отказа — как только
 * Gemini сам назовёт предел, запомнится и покажется он (см. noteQuotaHit).
 *
 * `spare` — можно ли переключиться на эту модель посреди ночи, когда у нынешней
 * кончились суточные запросы (см. nextSpareModel и --fallback в indexer.js).
 * Отмечены только обе Flash-Lite, и это не оплошность: у них пятьсот запросов
 * в сутки против двадцати у прочих, то есть переход с одной Lite на другую
 * продлевает ночь на несколько тысяч паков, а переход на старший Flash — на два
 * десятка, зато молча испортит смысл галочки «переспросить размеченное моделью
 * послабее»: паки окажутся размечены сильной моделью не потому, что их выбрали,
 * а потому, что ночью так легли лимиты.
 *
 * Моделей прошлых поколений здесь нет нарочно. Ключу они видны — `--gemini-models`
 * честно перечисляет и 2.5 Flash, и 2.5 Pro, и метаданные у них ничем не отличаются
 * от живых, — но на первом же запросе приходит отказ: «no longer available to new
 * users». Узнать это заранее нельзя ничем, кроме как попробовать, поэтому в список
 * попадают только проверенные, а всякая закрывшаяся впредь помечается сама
 * (см. noteUnavailable).
 */
export const MODELS = [
	{
		id: 'gemini-3.1-flash-lite',
		title: 'Gemini 3.1 Flash-Lite',
		note: 'Самая дешёвая и быстрая. Пятьсот паков в сутки — ею и проходят базу',
		rank: 1,
		rpd: 500,
		rpm: 15,
		tpm: 250_000,
		spare: true,
	},
	{
		id: 'gemini-3.5-flash-lite',
		title: 'Gemini 3.5 Flash-Lite',
		note: 'Разумная середина: те же пятьсот в сутки, а ошибается заметно реже',
		rank: 2,
		rpd: 500,
		rpm: 15,
		tpm: 250_000,
		spare: true,
	},
	{
		id: 'gemini-3-flash-preview',
		title: 'Gemini 3 Flash (предварительная)',
		note: 'Предварительная сборка: работает, но может закрыться без предупреждения',
		rank: 3,
		rpd: 20,
		rpm: 5,
		tpm: 250_000,
	},
	{
		id: 'gemini-3.5-flash',
		title: 'Gemini 3.5 Flash',
		note: 'Хорошо понимает шуточные названия тем. Двадцать запросов в сутки — только на важное',
		rank: 4,
		rpd: 20,
		rpm: 5,
		tpm: 250_000,
	},
	{
		id: 'gemini-3.6-flash',
		title: 'Gemini 3.6 Flash',
		note: 'Двадцать запросов в сутки — только на важное',
		rank: 5,
		rpd: 20,
		rpm: 5,
		tpm: 250_000,
	},
	{
		id: 'gemini-3.7-flash',
		title: 'Gemini 3.7 Flash',
		note: 'Самая новая и самая толковая из доступных. Двадцать запросов в сутки — только на важное',
		rank: 6,
		rpd: 20,
		rpm: 5,
		tpm: 250_000,
	},
];

const BY_ID = new Map(MODELS.map(model => [model.id, model]));

/** Что известно про модель. Незнакомая описывается по-минимуму, но работать не мешает. */
export function modelInfo(id) {
	return BY_ID.get(id) ?? { id, title: id, note: 'Модель не из списка: пределы неизвестны', rank: 0, rpd: null, rpm: 10, tpm: 250_000 };
}

/** Сила модели. По ней решается, что переспрашивать при переходе на модель посильнее. */
export function modelRank(id) {
	return BY_ID.get(id)?.rank ?? 0;
}

const MODEL_KEY = 'gemini_model';

/**
 * Выбранная модель. Хранится в базе, а не в config.js, потому что её меняют
 * на ходу со страницы обновления, — и ночной обход, который запускается сам,
 * должен подхватить тот же выбор.
 */
export function currentModel() {
	const chosen = getSetting(MODEL_KEY);
	return chosen && chosen.trim() ? chosen.trim() : config.geminiModel;
}

export function chooseModel(id) {
	setSetting(MODEL_KEY, id);
}

/**
 * Сутки, по которым Google считает суточную квоту, — тихоокеанские: она
 * сбрасывается в полночь по Лос-Анджелесу. По местным часам это середина дня,
 * и «сегодня» здешнее разошлось бы со «сегодня» гугловым на полсуток: расход
 * обнулялся бы, когда лимит ещё держит, и держался бы, когда его уже сбросили.
 */
export function quotaDay(at = Date.now()) {
	return new Intl.DateTimeFormat('en-CA', {
		timeZone: 'America/Los_Angeles',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).format(new Date(at));
}

/**
 * Даёт ли ключ поиск Google.
 *
 * Спросить об этом нечем — только попробовать: у ключа без поиска первый же
 * запрос с ним отвечает 429, будто кончилась суточная квота (см. src/gemini/api.js).
 * Запрос при этом тратится. Один такой на весь запуск не жалко, но индексатор
 * запускается и по десять раз за ночь, а точечное обновление — сколько угодно,
 * и каждый запуск начинал бы с одного и того же выброшенного запроса.
 *
 * Поэтому отказ запоминается на сутки: сегодня больше не пробуем, завтра
 * пробуем снова — платный тариф могли и включить.
 */
const SEARCH_KEY = 'gemini_search_refused';

export function searchRefused() {
	return getSetting(SEARCH_KEY) === quotaDay();
}

export function noteSearchRefused() {
	setSetting(SEARCH_KEY, quotaDay());
}

const bumpRequests = db.prepare(`
	INSERT INTO gemini_usage (day, model, requests) VALUES (?, ?, 1)
	ON CONFLICT (day, model) DO UPDATE SET requests = requests + 1
`);

const bumpQuotaHits = db.prepare(`
	INSERT INTO gemini_usage (day, model, quota_hits) VALUES (?, ?, 1)
	ON CONFLICT (day, model) DO UPDATE SET quota_hits = quota_hits + 1
`);

const rememberLimit = db.prepare(`
	INSERT INTO gemini_limits (model, day_limit, seen_at) VALUES (?, ?, ?)
	ON CONFLICT (model) DO UPDATE SET day_limit = excluded.day_limit, seen_at = excluded.seen_at
`);

const rememberRefusal = db.prepare(`
	INSERT INTO gemini_limits (model, unavailable, note, seen_at) VALUES (?, 1, ?, ?)
	ON CONFLICT (model) DO UPDATE SET unavailable = 1, note = excluded.note, seen_at = excluded.seen_at
`);

const forgetRefusal = db.prepare('UPDATE gemini_limits SET unavailable = 0 WHERE model = ?');

const readUsage = db.prepare('SELECT requests, quota_hits FROM gemini_usage WHERE day = ? AND model = ?');
const readLimit = db.prepare('SELECT day_limit, unavailable, note FROM gemini_limits WHERE model = ?');

/** Отмечает потраченный запрос. Зовётся на каждое обращение к модели, удачное или нет. */
export function noteRequest(model) {
	bumpRequests.run(quotaDay(), model);
	forgetRefusal.run(model);
}

/**
 * Модель отказалась работать насовсем: её закрыли для новых ключей или переименовали.
 * Запоминаем, чтобы в списке она была видна серой, а не выглядела рабочей до тех пор,
 * пока на неё не наткнётся ночной обход.
 */
export function noteUnavailable(model, reason) {
	rememberRefusal.run(model, String(reason ?? '').slice(0, 300), Date.now());
}

/**
 * Отмечает отказ по лимиту и, если Gemini назвал сам предел, запоминает его.
 * Именно этот случай и делает счётчик честным: до первого отказа мы знаем только
 * предположение из списка, после — то самое число, которым нас остановили.
 */
export function noteQuotaHit(model, dayLimit = null) {
	bumpQuotaHits.run(quotaDay(), model);

	if (Number.isFinite(dayLimit) && dayLimit > 0) {
		rememberLimit.run(model, dayLimit, Date.now());
	}
}

/**
 * Сколько запросов к модели потрачено сегодня и сколько осталось.
 * @returns {{model: string, spent: number, limit: number|null, exact: boolean, left: number|null, spentOut: boolean}}
 */
export function usage(model) {
	const row = readUsage.get(quotaDay(), model);
	const spent = row?.requests ?? 0;
	const learned = readLimit.get(model);
	const known = learned?.day_limit ?? null;
	const limit = known ?? modelInfo(model).rpd;

	return {
		model,
		spent,
		limit,
		// Предел назвал сам Gemini, а не наш список: такому числу можно верить
		exact: known !== null,
		left: limit === null ? null : Math.max(0, limit - spent),
		// Сегодня уже упирались: лимит кончился, сколько бы ни обещал список
		spentOut: (row?.quota_hits ?? 0) > 0,
		// Модель закрыта для этого ключа: дело не в лимитах, и завтра не отпустит
		unavailable: (learned?.unavailable ?? 0) === 1,
		refusal: learned?.note ?? null,
	};
}

/** Расход по всем моделям списка — для страницы обновления. */
export function usageReport() {
	const chosen = currentModel();

	return {
		day: quotaDay(),
		current: chosen,
		models: MODELS.map(model => ({ ...model, ...usage(model.id), current: model.id === chosen })),
	};
}

/**
 * Чем продолжать, когда у нынешней модели кончились суточные запросы.
 *
 * Ночь всегда обрывалась на этом месте: лимит выбран, шаг свернулся, половина
 * очереди осталась на завтра — при том, что у соседней модели того же ключа
 * лежат нетронутыми ещё пятьсот запросов. Квота у Gemini считается на модель,
 * а не на ключ, и это ровно тот случай, когда бросать работу незачем.
 *
 * Берётся сильнейшая из запасных (`spare` в списке выше), у которой на сегодня
 * что-то осталось: закрытые для ключа и уже упершиеся в предел пропускаются.
 * Нынешняя не предлагается никогда — иначе переключение зациклилось бы на ней же.
 *
 * ————— и почему у отбора есть второй вид —————
 *
 * `any` снимает условие `spare` и оставляет один порядок: сильнейшая из тех,
 * у кого на сегодня что-то осталось. Мерка `spare` считает выгоду ночи —
 * «на сколько ещё паков хватит», и по этой мерке старший Flash с его двадцатью
 * запросами в сутки не запасной вовсе: переход на него продлевает ночь на два
 * десятка паков и молча портит смысл галочки «переспросить размеченное моделью
 * послабее».
 *
 * У ежечасного обхода мерка другая, потому что и работа другая. Ему за час
 * нужен один пак, а не тысяча, и двадцати запросов на это хватает с запасом.
 * Бросить этот пак неразмеченным — значит показать его карточкой без типа,
 * без описания и без сложности до самой ночи; разметить сильнейшей из живых —
 * значит сделать его лучше, чем сделала бы ночь. Поэтому здесь берётся любая,
 * и берётся с самой мощной (см. --fallback=any в src/indexer/options.js).
 *
 * @param {string} current модель, у которой кончились запросы
 * @param {boolean} any брать любую модель, а не только запасную
 * @returns {string|null} чем продолжать, или null — продолжать нечем
 */
export function nextSpareModel(current = currentModel(), { any = false } = {}) {
	const candidates = MODELS
		.filter(model => (any || model.spare) && model.id !== current)
		.sort((a, b) => b.rank - a.rank);

	for (const model of candidates) {
		const state = usage(model.id);

		if (state.unavailable || state.spentOut) {
			continue;
		}

		if (state.left !== null && state.left <= 0) {
			continue;
		}

		return model.id;
	}

	return null;
}

/** Коротко, одной строкой: «потрачено 37 из ≈1000, осталось 963». */
export function usageLine(model) {
	const state = usage(model);

	if (state.unavailable) {
		return 'модель закрыта для этого ключа';
	}

	if (state.spentOut) {
		return `запросов сегодня: ${state.spent}, лимит кончился`;
	}

	if (state.limit === null) {
		return `запросов сегодня: ${state.spent}, суточный предел неизвестен`;
	}

	return `запросов сегодня: ${state.spent} из ${state.exact ? '' : '≈'}${state.limit}, осталось ${state.left}`;
}
