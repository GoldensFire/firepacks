// Доли тематик в паке. Категорию каждой темы определяет Gemini, здесь только арифметика.

import { config, EXCLUSIVE_TOPIC_KEYS, MUSIC_KEY, OTHER_KIND_KEYS, GENRES, isNotableGenre } from './config.js';
import { Names, nameKey, isFormatMarker, mergeRelated } from './franchise.js';

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

		const genre = topic === MUSIC_KEY
			? (mark.music ? mark.musicGenre : '')
			: (mark.category === topic ? mark.genre : '');

		if (!genre || !Object.hasOwn(GENRES[topic].list, genre)) {
			continue;
		}

		weights.set(genre, (weights.get(genre) ?? 0) + weight);
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
 * и состоит, и «повтор Истории» не говорит о паке ничего. Отсеиваются они
 * дважды: модель их не называет вовсе (см. правила для f и w в gemini.js),
 * а что всё же назовёт — снимает isFormatMarker в franchise.js.
 *
 * У музыки самой по себе (эстрада, рок, рэп) произведения нет, и повтор там —
 * это один и тот же ИСПОЛНИТЕЛЬ: пак, где четыре темы подряд про Земфиру,
 * перекошен ровно так же, как аниме-пак с четырьмя темами про Наруто. Модель
 * пишет исполнителей в то же поле w, так что считаются они здесь наравне
 * с произведениями. Саундтрек аниме, игры или кино — случай обычный: там в w
 * едет произведение, и повтор у опенингов считается по нему, а не по группе.
 *
 * @param {Array} themes темы из listThemes
 * @param {Map<string, {category: string, music: boolean, franchise: string, franchiseEn: string, works: string[]}>} marks
 * @returns {Array<{name: string, themes: number, questions: number, share: number}>}
 *   от частых к редким, только те, что встретились не реже franchiseMinThemes
 */
export function computeFranchises(themes, marks) {
	const names = new Names();
	const entries = [];
	const found = [];
	let total = 0;

	themes.forEach((theme, index) => {
		const weight = theme.questions > 0 ? theme.questions : 1;
		total += weight;

		const mark = marks.get(theme.key);

		// Формат и площадка произведением не являются: «Опенинги» у каждой
		// второй темы склеили бы пак-угадайку в одну выдуманную франшизу
		const real = name => Boolean(name) && !isFormatMarker(name);

		// Оба написания — одна сущность: «Атака титанов» и «Shingeki no Kyojin»
		// пришли из одной темы, значит это одно произведение, и тема, где названо
		// только английское имя, сойдётся с той, где названо только русское.
		const spellings = [mark?.franchise, mark?.franchiseEn]
			.map(name => String(name ?? '').trim())
			.filter(real);

		/** Разные произведения этой темы: по ним и делится её вес. */
		const canons = new Set();

		const remember = (raw, canon) => {
			const key = nameKey(raw);

			if (key) {
				entries.push({ key, raw, canon });
			}
		};

		if (spellings.length > 0) {
			const canon = names.addEntity(spellings);

			if (canon) {
				canons.add(canon);

				for (const raw of spellings) {
					remember(raw, canon);
				}
			}
		}

		// Названное в ответах. Каждое имя — своя сущность: связывать их между собой
		// нельзя, это разные произведения, случайно оказавшиеся в одной теме
		for (const raw of (mark?.works ?? []).map(name => String(name ?? '').trim()).filter(real)) {
			const key = nameKey(raw);

			if (!key) {
				continue;
			}

			const canon = names.add(key, raw);
			canons.add(canon);
			remember(raw, canon);
		}

		if (canons.size === 0) {
			return;
		}

		// Вес темы делится поровну: шесть вопросов про шесть разных тайтлов —
		// это по вопросу на тайтл. Тема с одним предметом достаётся ему целиком
		const share = weight / canons.size;

		for (const canon of canons) {
			found.push({ theme: index, canon, weight: share });
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
		.filter(([, group]) => group.themes.size >= config.franchiseMinThemes)
		.map(([root, group]) => ({
			name: names.display(root),
			themes: group.themes.size,
			questions: Math.round(group.questions),
			share: Math.round((group.questions / total) * 1000) / 1000,
		}))
		.sort((a, b) => b.share - a.share || b.themes - a.themes)
		.slice(0, config.franchiseLimit);
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
