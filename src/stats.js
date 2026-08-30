// Обращение к сервису статистики SIGame и расчёт уровня сложности.

import { config } from './config.js';

/**
 * Ниже скольких игр ответ сервиса не похож на настоящую жизнь пака.
 *
 * Число это — не порог доверия к статистике (для этого есть
 * minGamesForDifficulty), а признак того, что мы спросили не под тем именем:
 * см. fetchPackageStats. Пять взято по замерам — среди семидесяти паков
 * с тремя и более играми правильное имя прибавило одному ровно одну игру,
 * а вот у пака с одной игрой их оказалось полторы тысячи.
 */
const THIN_GAMES = 5;

/**
 * Один запрос к сервису. Ищет он пак по имени и авторам из самого файла
 * и сверяет имя побайтно: «Лайтовая солянка» и «Лайтовая солянка » для него
 * два разных пака, и про второй он ответит 404.
 *
 * @returns null, если пак сервису неизвестен
 */
async function ask(name, authors) {
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

/** Сколько игр в ответе сервиса. */
const games = stats => stats?.topLevelStats?.startedGameCount ?? 0;

/**
 * Статистика пака: спрашиваем под его именем, а если ответа нет или он
 * неправдоподобно мал — переспрашиваем под именем с концевым пробелом.
 *
 * ————— откуда взялся этот пробел —————
 *
 * Имя пака лежит в content.xml, и у части паков оно кончается пробелом:
 * `<package name="Ночные посиделки №85 " …>`. Разбор архива этот пробел
 * срезает (см. parseContentXml в src/siq.js) — и правильно делает: по имени
 * складываются ключ пака, адрес страницы и подпись на карточке, и пробел
 * в конце там не нужен никому.
 *
 * Никому, кроме сервиса статистики. Он сверяет имя побайтно, и срезанный
 * пробел означает, что мы спрашиваем про несуществующий пак. Так и стояли
 * без статистики «Ночные посиделки №85» (под тысячу игр), «Почти
 * музыкальный (1)» (без малого триста) и ещё сотня с небольшим — около
 * процента библиотеки, если считать по выборке архивов.
 *
 * ————— почему мало игр — тоже промах, а не просто мало игр —————
 *
 * Обрезанное имя не всегда даёт 404. У сервиса заводится вторая запись — под
 * ней лежит одна случайная игра, сыгранная кем-то с переименованной копией
 * пака, — и мы попадали именно в неё. «Киберспортивный Counter-Strike
 * от GoldensFire» показывал одну игру вместо полутора тысяч. Поэтому переспрашиваем
 * не только после 404, но и после ответа тоньше THIN_GAMES, а из двух ответов
 * берём тот, где игр больше: обе записи про один и тот же пак, и настоящая
 * его жизнь — большая из них.
 *
 * ————— почему не хранить настоящее имя —————
 *
 * Потому что взять его неоткуда, кроме как из архива, а это два range-запроса
 * на пак: по замеру — четыре с лишним часа на всю библиотеку ради сотни паков,
 * и в одну ночь это не влезает (см. BUDGET_DEFAULT в scripts/nightly.js).
 * Лишний вопрос к сервису стоит полсекунды и задаётся только тем пакам,
 * про которых он и так ответил пусто, — то есть тем, кого всё равно стоило
 * переспросить. Отдельная колонка, кроме того, стоила бы полной перезаливки
 * packages в D1 (см. «поменялась схема таблиц» в scripts/export-d1.js) ради
 * поля, которого сайт не показывает.
 *
 * Если однажды обнаружится пробел не в конце, а в начале имени — лечится он
 * здесь же, ещё одним вариантом.
 *
 * @returns null, если пак сервису неизвестен ни под одним из имён
 */
export async function fetchPackageStats(name, authors) {
	const exact = await ask(name, authors);

	if (games(exact) >= THIN_GAMES) {
		return exact;
	}

	const padded = await ask(`${name} `, authors);

	if (!padded) {
		return exact;
	}

	return games(padded) > games(exact) ? padded : exact;
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
