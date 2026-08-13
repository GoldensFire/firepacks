// Обращение к сервису статистики SIGame и расчёт уровня сложности.

import { config } from './config.js';

/**
 * Запрашивает статистику пака. Сервис ищет пак по имени и авторам из самого файла.
 * @returns null, если пак сервису неизвестен
 */
export async function fetchPackageStats(name, authors) {
	const query = new URLSearchParams({
		name,
		hash: '',
		authors: (authors ?? []).join(','),
	});

	const response = await fetch(`${config.statisticsUri}/api/v1/games/packages/stats?${query}`, {
		headers: { 'User-Agent': config.userAgent },
	});

	if (response.status === 404) {
		return null;
	}

	if (!response.ok) {
		throw new Error(`статистика ответила HTTP ${response.status}`);
	}

	return response.json();
}

/**
 * Сводит статистику по вопросам в один показатель сложности.
 *
 * takePercent — доля вопросов, на которые решились ответить. По ней считается сложность.
 * rightPercent — доля правильных из тех ответов, что вообще прозвучали. Показываем справочно.
 */
export function summarize(stats) {
	const questions = Object.values(stats?.questionStats ?? {});

	let shown = 0;
	let answered = 0;
	let correct = 0;
	let wrong = 0;

	for (const question of questions) {
		shown += question.shownCount ?? 0;
		answered += question.answeredCount ?? 0;
		correct += question.correctCount ?? 0;
		wrong += question.wrongCount ?? 0;
	}

	const tries = correct + wrong;

	return {
		startedGames: stats?.topLevelStats?.startedGameCount ?? 0,
		completedGames: stats?.topLevelStats?.completedGameCount ?? 0,
		shown,
		answered,
		correct,
		wrong,
		rightPercent: tries > 0 ? (correct / tries) * 100 : null,
		takePercent: shown > 0 ? (answered / shown) * 100 : null,
	};
}

/**
 * Превращает процент в уровень: 4 — лёгкий, 3 — средний, 2 — сложный, 1 — очень сложный.
 * Возвращает null, если игр слишком мало и оценке нельзя верить.
 *
 * Считается по доле вопросов, на которые вообще решились ответить: молчание за столом —
 * куда более честный признак сложного пака, чем доля правильных ответов. Правильных
 * почти везде выходит около 60%: на трудный вопрос просто никто не жмёт, и в этот
 * процент он не попадает вовсе.
 *
 * Но когда правильных всё же мало — меньше hardRightPercent, — пак поднимается
 * на ступень сложности выше. Это как раз тот случай, который один процент попыток
 * не ловит: отвечать берутся охотно, а попадают мимо, и за столом такой пак
 * ощущается труднее, чем выглядит по проценту. Ступень одна, ниже «очень сложного»
 * правило не уводит.
 *
 * То же правило продублировано на SQL в db.js: уровни пересчитываются при запуске.
 */
export function toLevel(summary) {
	if (!summary || summary.takePercent === null) {
		return null;
	}

	if (summary.startedGames < config.minGamesForDifficulty) {
		return null;
	}

	if (summary.shown < config.minShownForDifficulty) {
		return null;
	}

	const { easy, medium, hard } = config.difficultyThresholds;
	const value = summary.takePercent;

	let level;

	if (value > easy) {
		level = 4;
	} else if (value >= medium) {
		level = 3;
	} else if (value >= hard) {
		level = 2;
	} else {
		level = 1;
	}

	const right = summary.rightPercent ?? null;

	if (right !== null && right < config.hardRightPercent) {
		level = Math.max(1, level - 1);
	}

	return level;
}
