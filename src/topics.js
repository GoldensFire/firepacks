// Доли тематик в паке. Категорию каждой темы определяет Gemini, здесь только арифметика.

import {
	config, EXCLUSIVE_TOPIC_KEYS, MUSIC_KEY, OTHER_KIND_KEYS, GENRES, isNotableGenre,
	ORIGIN_KEYS, DECADE_MIN,
} from './config.js';
import { Names, nameKey, isFormatMarker, isAreaName, mergeRelated } from './franchise.js';

/** Доля до тысячных: доли пака дальше третьего знака не значат ничего. */
const round = value => Math.round(value * 1000) / 1000;

/**
 * Делит вес темы между тем, что в ней названо, — в той пропорции, в какой
 * модель это назвала.
 *
 * Одна арифметика на три полоски: жанры, десятилетия и «наше — зарубежное»
 * считаются совершенно одинаково, и разница между ними только в том, какой
 * список брать. Тема на шесть вопросов, где три ответа рэп, два поп и один
 * рок, — это три вопроса рэпу, два попу и один року, а не шесть вопросов рэпу.
 *
 * @param {Map} weights куда прибавлять
 * @param {Array<{key: *, count: number}>} list что назвала модель
 * @param {number} weight вес темы целиком
 * @param {(key: *) => boolean} accept годится ли ключ
 * @returns {number} сколько веса разошлось: остальное в счёт не идёт
 */
function spread(weights, list, weight, accept = () => true) {
	const good = (list ?? []).filter(item => item?.count > 0 && accept(item.key));
	const total = good.reduce((sum, item) => sum + item.count, 0);

	if (total === 0) {
		return 0;
	}

	for (const item of good) {
		const share = (weight * item.count) / total;
		weights.set(item.key, (weights.get(item.key) ?? 0) + share);
	}

	return weight;
}

/** Устойчивый ключ темы: по нему ответ модели возвращается на своё место. */
export function themeKey(packageId, roundIndex, themeIndex) {
	return `${packageId}:${roundIndex}:${themeIndex}`;
}

/** Перечисляет темы пака вместе с ключами. */
export function listThemes(packageId, rounds) {
	const themes = [];

	rounds.forEach((round, roundIndex) => {
		round.themes.forEach((theme, themeIndex) => {
			themes.push({
				key: themeKey(packageId, roundIndex, themeIndex),
				name: theme.name,
				sample: theme.sample,
				media: theme.media ?? '',
				questions: theme.questions,
			});
		});
	});

	return themes;
}

/**
 * Считает доли по вопросам, а не по темам: тема на десять вопросов
 * должна весить больше темы на три.
 *
 * Доли исключающих категорий в сумме дают единицу, а доля музыки идёт поверх них
 * и в эту сумму не входит: тема с опенингами аниме учитывается и в аниме, и в музыке.
 *
 * @param {Array} themes темы из listThemes
 * @param {Map<string, {category: string, music: boolean}>} marks ключ темы -> разметка
 */
export function computeShares(themes, marks) {
	const weights = Object.fromEntries(EXCLUSIVE_TOPIC_KEYS.map(key => [key, 0]));
	let music = 0;
	let total = 0;

	for (const theme of themes) {
		const weight = theme.questions > 0 ? theme.questions : 1;
		const mark = marks.get(theme.key) ?? { category: 'other', music: false };
		const category = EXCLUSIVE_TOPIC_KEYS.includes(mark.category) ? mark.category : 'other';

		weights[category] += weight;

		if (mark.music) {
			music += weight;
		}

		total += weight;
	}

	if (total === 0) {
		return { shares: null, questions: 0 };
	}

	const round = value => Math.round((value / total) * 1000) / 1000;
	const shares = {};

	for (const key of EXCLUSIVE_TOPIC_KEYS) {
		shares[key] = round(weights[key]);
	}

	shares[MUSIC_KEY] = round(music);

	return { shares, questions: total };
}

/**
 * Считает, чем оказалось «прочее»: сколько вопросов пака про стримеров, сколько
 * про историю, сколько про спорт.
 *
 * Доли считаются от всего пака, а не от одного «прочего», и это нарочно: вопрос,
 * на который отвечает этот список, — «стоит ли писать это на карточке», а не
 * «как поделено прочее внутри себя». Пак, где прочего пять процентов и всё оно
 * про стримеров, стримерским не является никак.
 *
 * @param {Array} themes темы из listThemes
 * @param {Map<string, {category: string, kind: string}>} marks
 * @returns {Array<{key: string, questions: number, share: number}>} от частых
 *   к редким, только те, что взяли порог otherKindShare
 */
export function computeOtherKinds(themes, marks) {
	const weights = new Map();
	let total = 0;

	for (const theme of themes) {
		const weight = theme.questions > 0 ? theme.questions : 1;
		total += weight;

		const mark = marks.get(theme.key);

		if (mark?.category !== 'other' || !OTHER_KIND_KEYS.includes(mark.kind)) {
			continue;
		}

		weights.set(mark.kind, (weights.get(mark.kind) ?? 0) + weight);
	}

	if (total === 0) {
		return [];
	}

	return [...weights.entries()]
		.map(([key, questions]) => ({ key, questions, share: Math.round((questions / total) * 1000) / 1000 }))
		.filter(kind => kind.share >= config.otherKindShare)
		.sort((a, b) => b.questions - a.questions)
		.slice(0, config.otherKindLimit);
}

/**
 * Считает жанры внутри тематики пака: чем этот музпак отличается от соседнего.
 *
 * Спрашивать это имеет смысл только у пака, который чем-то одним и является:
 * тип пака (см. toPrimary) отвечает на вопрос «откуда вопросы», и у музпака
 * ответ на него известен заранее — музыка. А вот русский рэп внутри или опенинги
 * нулевых, не видно было ниоткуда, хотя играются такие паки совсем по-разному.
 *
 * Что считать жанром, зависит от типа пака, и это не мелочь. У музпака жанр
 * берётся у музыкальных тем — у всех, какой бы категории они ни были: опенинги
 * аниме в музпаке это тоже музыка, и жанр у них музыкальный (анисонги).
 * У остальных — жанр тем своей категории: в аниме-паке считаются аниме-темы,
 * а случайная тема про футбол жанра аниме не имеет и в счёт не идёт.
 *
 * Доли считаются от всего пака, как и у видов «прочего»: вопрос здесь —
 * «стоит ли писать это на карточке», а не «как поделена одна тематика внутри
 * себя». Пак, где аниме-тем всего пятая часть, исекайным не является никак.
 *
 * @param {Array} themes темы из listThemes
 * @param {Map<string, {category: string, music: boolean, genre: string, musicGenre: string}>} marks
 * @param {string|null} topic тип пака: по нему выбирается список жанров
 * @returns {Array<{key: string, questions: number, share: number}>} от частых
 *   к редким, только те, что взяли порог genreShare
 */
export function computeGenres(themes, marks, topic) {
	if (!topic || !GENRES[topic]) {
		return [];
	}

	const weights = new Map();
	let total = 0;

	for (const theme of themes) {
		const weight = theme.questions > 0 ? theme.questions : 1;
		total += weight;

		const mark = marks.get(theme.key);

		if (!mark) {
			continue;
		}

		// Жанры темы приходят списком с числами — «поп 3, рэп 2, рок 1», —
		// и вес темы делится между ними в этой же пропорции. Раньше жанр был
		// один, и вся тема доставалась ему целиком: тема-угадайка, где подряд
		// идут четыре разных жанра, отдавала весь свой вес самому частому,
		// и музпак выходил «поп на 90%» при попе в четверть (см. THEME_RULES)
		const list = topic === MUSIC_KEY
			? (mark.music ? mark.musicGenres : [])
			: (mark.category === topic ? mark.genres : []);

		spread(weights, list, weight, key => Object.hasOwn(GENRES[topic].list, key));
	}

	if (total === 0) {
		return [];
	}

	const passed = [...weights.entries()]
		.map(([key, questions]) => ({ key, questions, share: Math.round((questions / total) * 1000) / 1000 }))
		.filter(genre => genre.share >= config.genreShare)
		.sort((a, b) => b.questions - a.questions);

	// Обрезка по числу — про то, что список не резиновый, а не про то, что
	// отсечённого в паке нет. Меха и махо-сёдзё через эту обрезку проходят
	// всегда: взяли свою десятую часть — значит, будут названы, сколько бы
	// жанров ни стояло выше (см. NOTABLE_GENRES в settings.js)
	const shown = passed.slice(0, config.genreLimit);
	const notable = passed.slice(config.genreLimit).filter(genre => isNotableGenre(topic, genre.key));

	return [...shown, ...notable];
}

/**
 * Когда вышло то, из чего собран пак: разбивка по десятилетиям.
 *
 * Полоска эта отвечает на вопрос, которого не задаёт ни один ярлык. «Музпак»
 * и «музпак» — это и сборник восьмидесятых, и сборник прошлогодних тиктоков,
 * а играются они разными людьми и по-разному; то же и с кино, и с играми,
 * и с аниме. Возраст аудитории про это намекает, но косвенно: пак про игры
 * нулевых интересен тридцатилетним — а вот что он именно про нулевые, видно
 * только отсюда.
 *
 * Считается там же, где жанры, и той же арифметикой: модель называет годы
 * поштучно по ответам темы (поле y, см. gemini.js), вес темы делится между
 * названными десятилетиями.
 *
 * Возвращается вместе с покрытием — какой частью пака эта разбивка посчитана.
 * Года есть далеко не у всего: у темы про мемы или про столицы его нет и быть
 * не должно, и полоска, собранная по одной десятой пака, врала бы с уверенным
 * видом. Показывать её или нет, решает уже сайт (см. decadeCoverage).
 *
 * @returns {{decades: Array<{key: number, questions: number, share: number}>, coverage: number}}
 */
export function computeDecades(themes, marks) {
	const weights = new Map();
	let total = 0;
	let known = 0;

	for (const theme of themes) {
		const weight = theme.questions > 0 ? theme.questions : 1;
		total += weight;
		known += spread(weights, marks.get(theme.key)?.decades, weight, key => key >= DECADE_MIN);
	}

	if (total === 0 || known === 0) {
		return { decades: [], coverage: 0 };
	}

	// Доли считаются от НАЗВАННОГО, а не от всего пака: полоска отвечает
	// на вопрос «каких лет это всё», и вопросы без года в этот счёт не входят
	// (иначе полоска была бы вечно недозаполнена, и читалось бы это как
	// «остальное не посчитано»). А насколько ответу вообще можно верить,
	// говорит покрытие — оно уезжает отдельным числом
	const decades = [...weights.entries()]
		.map(([key, questions]) => ({ key, questions, share: round(questions / known) }))
		.filter(decade => decade.share >= config.decadeShare)
		.sort((a, b) => a.key - b.key)
		.slice(0, config.decadeLimit);

	return { decades, coverage: round(known / total) };
}

/**
 * Откуда родом то, из чего собран пак: сколько в нём советского, российского,
 * постсоветского и иностранного.
 *
 * Вопрос стоит у музыки и кино, и там он главный после самого жанра: «музпак»
 * одинаково называется и сборник русского рэпа, и сборник западной эстрады,
 * а собираются под них разные компании. Жанр на это не отвечает — рок бывает
 * и наш, и не наш.
 *
 * Считается по числам, которые модель называет поштучно по ответам темы
 * (поле og, см. gemini.js), и той же арифметикой, что жанры и десятилетия:
 * тема на шесть вопросов, где четыре ответа советские, а два иностранные, —
 * это четыре вопроса советскому и два иностранному, а не вся тема одному.
 *
 * Покрытие то же и по той же причине, что у десятилетий: у вопроса про мем
 * или про столицы происхождения нет.
 *
 * @returns {{origins: Array<{key: string, questions: number, share: number}>, coverage: number}}
 */
export function computeOrigin(themes, marks) {
	const weights = new Map();
	let total = 0;
	let known = 0;

	for (const theme of themes) {
		const weight = theme.questions > 0 ? theme.questions : 1;
		total += weight;
		known += spread(weights, marks.get(theme.key)?.origins, weight, key => ORIGIN_KEYS.includes(key));
	}

	if (total === 0 || known === 0) {
		return { origins: [], coverage: 0 };
	}

	// Порядок здесь не по величине, а свой, всегда одинаковый (см. ORIGINS):
	// у полоски перескакивающие местами цвета читаются как разные полоски,
	// а «иностранное» стоит в ней последним куском всегда
	const origins = ORIGIN_KEYS
		.map(key => ({ key, questions: weights.get(key) ?? 0, share: round((weights.get(key) ?? 0) / known) }))
		.filter(part => part.questions > 0);

	return { origins, coverage: round(known / total) };
}

/**
 * Считает, сколько раз пак возвращается к одной и той же франшизе. Один «Наруто»
 * среди тридцати тем — это просто тема; четыре «Наруто» — уже перекос, из-за
 * которого пак играется совсем не так, как обещает его описание.
 *
 * Сведением написаний к одному произведению занимается franchise.js — порт той
 * же логики, по которой считает повторы SI-HYX. Простого сравнения строк тут
 * мало: модель зовёт одно и то же то «Атака титанов», то «Shingeki no Kyojin»,
 * то «Атака Титанов: Финал», и без сведения пак с двадцатью темами про титанов
 * не получал ни одного повтора.
 *
 * ————— почему считается не по предмету темы —————
 *
 * Сначала повтор искали по одному только предмету темы (поля f и fe) — по тому,
 * чему тема посвящена ЦЕЛИКОМ. На живых паках это находило почти ничего.
 * Аниме-пак устроен темами-угадайками: «Опенинги», «Женщины», «Силуэты
 * персонажей», «Эдиты», — и ни одна из них целиком ничему не посвящена, предмета
 * у неё нет и быть не должно. Пак от deeathyy #5, где ДжоДжо всплывает в пяти
 * темах подряд, получал ровно ноль повторов: тема про стенды ДжоДжо была одна,
 * а остальные четыре упоминания прятались в ответах.
 *
 * Поэтому модель называет ещё и список произведений, прозвучавших в ответах темы
 * (поле w, см. gemini.js), и повтор считается по нему. Вес темы делится поровну
 * между названными в ней произведениями: тема на шесть вопросов, где названо
 * шесть разных тайтлов, — это по одному вопросу на каждый, а не шесть вопросов
 * каждому. Тема же, у которой есть предмет, так и остаётся целиком за ним.
 *
 * Тема считается за повтор один раз на произведение, сколько бы раз оно в ней
 * ни прозвучало: три вопроса про ДжоДжо в одной теме — это одна тема про ДжоДжо,
 * а не три.
 *
 * ————— что повтором не считается —————
 *
 * Только произведение. Область знаний — «История», «География», «Химия»,
 * «Футбол», «Вторая мировая война» — повтором не бывает: викторина вся из них
 * и состоит, и «повтор Истории» не говорит о паке ничего. Сюда они не попадают
 * дважды: модель называет область отдельными полями (a и ae, см. gemini.js),
 * а что всё же придёт франшизой — снимает isFormatMarker в franchise.js.
 * Считает области computeAreas ниже, и пропасть они не пропадают: пак
 * целиком про футбол получает по ним свою подпись.
 *
 * У музыки самой по себе (эстрада, рок, рэп) произведения нет, и повтор там —
 * это один и тот же ИСПОЛНИТЕЛЬ: пак, где четыре темы подряд про Земфиру,
 * перекошен ровно так же, как аниме-пак с четырьмя темами про Наруто. Модель
 * пишет исполнителей в то же поле w, так что считаются они здесь наравне
 * с произведениями. Саундтрек аниме, игры или кино — случай обычный: там в w
 * едет произведение, и повтор у опенингов считается по нему, а не по группе.
 *
 * @param {Array} themes темы из listThemes
 * @param {Map<string, {category: string, music: boolean, franchise: string, franchiseEn: string, area: string, areaEn: string, works: string[]}>} marks
 * @returns {Array<{name: string, themes: number, questions: number, share: number, kind: string}>}
 *   от частых к редким, только те, что заняли свою часть пака (см. minThemes)
 */
export function computeFranchises(themes, marks) {
	return countNamed(themes, marks, mark => [
		// Оба написания — одна сущность: «Атака титанов» и «Shingeki no Kyojin»
		// пришли из одной темы, значит это одно произведение, и тема, где названо
		// только английское имя, сойдётся с той, где названо только русское.
		// whole — «тема посвящена этому целиком», и вес темы достаётся ему весь
		{ names: [mark?.franchise, mark?.franchiseEn], whole: true },
		// Названное в ответах. Каждое имя — своя сущность: связывать их между собой
		// нельзя, это разные произведения, случайно оказавшиеся в одной теме.
		// Тема таким не посвящена — они в ней всего лишь прозвучали
		...(mark?.works ?? []).map(name => ({ names: [name], whole: false })),
	], {
		kind: 'work',
		limit: config.franchiseLimit,
		// Порог считается от самого пака: две темы — это повтор, когда тем шесть,
		// и случайность, когда их тридцать (см. franchiseThemeShare в settings.js)
		minThemes: Math.max(config.franchiseMinThemes, Math.ceil(themes.length * config.franchiseThemeShare)),
		// Область произведением не является, и что бы модель ни написала
		// в поле произведения, повтором это не станет
		skip: isAreaName,
	});
}

/**
 * То же самое, но по областям: «Футбол», «Вторая мировая война», «Столицы».
 *
 * Считается врозь от франшиз, потому что означает другое. Повтор — это то,
 * к чему пак возвращается снова и снова, и возвращаться можно только
 * к произведению: пак, где есть тема про столицы и тема про реки, дважды
 * ни к чему не вернулся — это обычная викторина, и «повтор Географии» о нём
 * не говорит ничего.
 *
 * А вот подпись паку, который целиком про футбол или про Вторую мировую,
 * область даёт — и никто, кроме неё: ярлык у такого пака «Прочее», и что
 * за прочее, видно только отсюда (см. subjectPackShare в settings.js).
 * Поэтому области считаются, но кучкой отдельной: показывает их сайт не рядом
 * с повторами, а в ярлыке-мишени (см. kind в web/card.js).
 */
export function computeAreas(themes, marks) {
	return countNamed(themes, marks, mark => [{ names: [mark?.area, mark?.areaEn], whole: true }], {
		kind: 'area',
		limit: config.areaLimit,
	});
}

/**
 * Общий счёт названного по темам: сводит написания к одной сущности, делит вес
 * темы между названным в ней и собирает кучки. Франшизы и области считаются
 * им одинаково — разница только в том, какие поля разметки брать.
 *
 * @param {Array} themes темы из listThemes
 * @param {Map} marks разметка по ключу темы
 * ————— почему упоминание весит один вопрос —————
 *
 * Вес темы делился между названным в ней поровну, и на угадайках это врало
 * в разы. Модель видит не всю тему, а выжимку — первые несколько ответов
 * (см. buildSample в siq.js), — и называет то, что в этой выжимке попалось.
 * Тема «Что было дальше?» на шесть вопросов, где в выжимку попал один Оверлорд,
 * отдавала Оверлорду все шесть: пак получал «Оверлорд, 8 вопросов» там, где
 * на деле вопрос был один, и вставал в повторы выше настоящих.
 *
 * Поэтому названное в ответах весит один вопрос — ровно то, что про него
 * известно наверняка: оно там прозвучало. Больше одного даётся только предмету
 * темы (whole) — тому, чему тема посвящена целиком: тема про стенды ДжоДжо
 * и есть шесть вопросов про ДжоДжо. А если названного в теме больше, чем в ней
 * вопросов, вес делится поровну — сумма упоминаний темы её саму не перевешивает.
 *
 * @param {Array} themes темы из listThemes
 * @param {Map} marks разметка по ключу темы
 * @param {(mark: object) => Array<{names: string[], whole: boolean}>} entitiesOf
 *   сущности темы: names — написания ОДНОГО И ТОГО ЖЕ, которые надо связать
 *   между собой; whole — посвящена ли тема этому целиком
 * @param {{kind: string, limit: number, skip?: (name: string) => boolean}} options
 *   чем помечать найденное, сколько хранить и что не считать за название
 */
function countNamed(themes, marks, entitiesOf, { kind, limit, skip = null, minThemes = config.franchiseMinThemes }) {
	const names = new Names();
	const entries = [];
	const found = [];
	let total = 0;

	themes.forEach((theme, index) => {
		const weight = theme.questions > 0 ? theme.questions : 1;
		total += weight;

		const mark = marks.get(theme.key);

		// Формат и площадка названием не являются: «Опенинги» у каждой второй темы
		// склеили бы пак-угадайку в одну выдуманную франшизу. Что ещё не в счёт —
		// решает тот, кто считает: повторам не годятся области (см. franchise.js)
		const real = name => Boolean(name) && !isFormatMarker(name) && !(skip && skip(name));

		/** Разные сущности этой темы: чему она посвящена и что в ней прозвучало. */
		const canons = new Map();

		const remember = (raw, canon) => {
			const key = nameKey(raw);

			if (key) {
				entries.push({ key, raw, canon });
			}
		};

		for (const entity of entitiesOf(mark ?? {})) {
			const spellings = (entity.names ?? []).map(name => String(name ?? '').trim()).filter(real);

			if (spellings.length === 0) {
				continue;
			}

			const canon = names.addEntity(spellings);

			if (!canon) {
				continue;
			}

			// Названное и предметом темы, и в её ответах остаётся предметом:
			// тема, посвящённая «Наруто», не перестаёт быть посвящённой ему
			// оттого, что «Наруто» назван ещё и в списке прозвучавшего
			canons.set(canon, canons.get(canon) || entity.whole === true);

			for (const raw of spellings) {
				remember(raw, canon);
			}
		}

		if (canons.size === 0) {
			return;
		}

		// Упоминание весит один вопрос, а названного больше, чем вопросов, —
		// делим поровну. Предмету темы достаётся вся тема: он и есть тема
		const mention = Math.min(1, weight / canons.size);

		for (const [canon, whole] of canons) {
			found.push({ theme: index, canon, weight: whole ? weight : mention });
		}
	});

	if (total === 0 || found.length === 0) {
		return [];
	}

	// Сезоны, спин-оффы и короткие имена — их видно только по набору целиком
	mergeRelated(names, entries);

	const groups = new Map();

	for (const { theme, canon, weight } of found) {
		// Канон берём заново: mergeRelated мог переподчинить его другому корню
		const root = names.find(canon);
		let group = groups.get(root);

		if (!group) {
			// Темы считаем множеством, а не счётчиком: два названия одной темы
			// могли после слияния оказаться одним произведением («Наруто»
			// и «Наруто Шиппуден»), и тогда это одна тема, а не две
			group = { themes: new Set(), questions: 0 };
			groups.set(root, group);
		}

		group.themes.add(theme);
		group.questions += weight;
	}

	return [...groups.entries()]
		.filter(([, group]) => group.themes.size >= minThemes)
		.map(([root, group]) => ({
			name: names.display(root),
			themes: group.themes.size,
			questions: Math.round(group.questions),
			share: Math.round((group.questions / total) * 1000) / 1000,
			// Произведение это или область. Хранится у каждой записи, потому что
			// лежат они в базе одним списком, а означают разное: повторы сайт
			// показывает только по произведениям
			kind,
		}))
		.sort((a, b) => b.share - a.share || b.themes - a.themes)
		.slice(0, limit);
}

/** Музыкальный ли пак: доля музыкальных вопросов взяла свой порог. */
export function isMusical(shares) {
	return (shares?.[MUSIC_KEY] ?? 0) >= config.musicThreshold;
}

/**
 * Ярлык пака: категория, набравшая больше порога. Ниже порога — солянка,
 * слишком мало вопросов — без ярлыка.
 *
 * Музыка в этом соревновании не участвует: она не спорит с аниме или кино,
 * а идёт рядом отдельным ярлыком. Но если ни одна из обычных категорий порог
 * не взяла, а музыки много, пак всё же музыкальный, а не солянка.
 */
export function toPrimary(shares, questions) {
	if (!shares) {
		return { topic: null, share: null, musical: false };
	}

	const musical = isMusical(shares);

	const [topic, share] = EXCLUSIVE_TOPIC_KEYS
		.filter(key => key !== 'other')
		.map(key => [key, shares[key] ?? 0])
		.sort((a, b) => b[1] - a[1])[0];

	if (questions < config.topicMinQuestions) {
		return { topic: null, share, musical };
	}

	if (share >= config.topicThreshold) {
		return { topic, share, musical };
	}

	if (musical) {
		return { topic: MUSIC_KEY, share: shares[MUSIC_KEY], musical };
	}

	return { topic: 'mixed', share, musical };
}
