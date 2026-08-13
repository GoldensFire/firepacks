// Доли тематик в паке. Категорию каждой темы определяет Gemini, здесь только арифметика.

import { config, EXCLUSIVE_TOPIC_KEYS, MUSIC_KEY } from './config.js';
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
 * @param {Array} themes темы из listThemes
 * @param {Map<string, {category: string, music: boolean, franchise: string, franchiseEn: string}>} marks
 * @returns {Array<{name: string, themes: number, questions: number, share: number}>}
 *   от частых к редким, только те, что встретились не реже franchiseMinThemes
 */
export function computeFranchises(themes, marks) {
	const names = new Names();
	const entries = [];
	const found = [];
	let total = 0;

	for (const theme of themes) {
		const weight = theme.questions > 0 ? theme.questions : 1;
		total += weight;

		const mark = marks.get(theme.key);

		// Оба написания — одна сущность: «Атака титанов» и «Shingeki no Kyojin»
		// пришли из одной темы, значит это одно произведение, и тема, где названо
		// только английское имя, сойдётся с той, где названо только русское.
		const spellings = [mark?.franchise, mark?.franchiseEn]
			.map(name => String(name ?? '').trim())
			// Формат и площадка произведением не являются: «Опенинги» у каждой
			// второй темы склеили бы пак-угадайку в одну выдуманную франшизу
			.filter(name => name && !isFormatMarker(name));

		if (spellings.length === 0) {
			continue;
		}

		const canon = names.addEntity(spellings);

		if (!canon) {
			continue;
		}

		for (const raw of spellings) {
			const key = nameKey(raw);

			if (key) {
				entries.push({ key, raw, canon });
			}
		}

		found.push({ canon, weight });
	}

	if (total === 0 || found.length === 0) {
		return [];
	}

	// Сезоны, спин-оффы и короткие имена — их видно только по набору целиком
	mergeRelated(names, entries);

	const groups = new Map();

	for (const { canon, weight } of found) {
		// Канон берём заново: mergeRelated мог переподчинить его другому корню
		const root = names.find(canon);
		let group = groups.get(root);

		if (!group) {
			group = { themes: 0, questions: 0 };
			groups.set(root, group);
		}

		group.themes++;
		group.questions += weight;
	}

	return [...groups.entries()]
		.filter(([, group]) => group.themes >= config.franchiseMinThemes)
		.map(([root, group]) => ({
			name: names.display(root),
			themes: group.themes,
			questions: group.questions,
			share: Math.round((group.questions / total) * 1000) / 1000,
		}))
		.sort((a, b) => b.questions - a.questions || b.themes - a.themes)
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
