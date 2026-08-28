// Пересчёт по тому, что уже лежит в базе: уровни сложности и ярлыки паков.
//
// Ни сети, ни модели — применяет нынешние пороги из настроек к сохранённым
// числам. Нужен после правки порогов: разметку при этом никто не переспрашивает,
// меняется только то, как из неё делаются выводы.

import { config, MISC_KEY } from '../config.js';
import { db, jsonOrDefault, repeatShare } from '../db.js';
import { toLevel } from '../stats.js';
import { toPrimary } from '../topics.js';
import { isCategoryName } from '../franchise.js';
import { say } from './progress.js';
import { targetSql } from './queue.js';

/** Пересчитывает уровни по уже сохранённым числам — нужен после правки порогов в настройках. */
function recalcLevels() {
	// Названные поимённо паки пересчитываются одни: точечное обновление не должно
	// трогать соседей — даже пересчётом, который ничего не портит
	const target = targetSql();
	const only = target.where
		? ` AND package_id IN (SELECT p.id FROM packages p WHERE 1 = 1${target.where})`
		: '';

	const rows = db.prepare(`SELECT package_id, started_games, completed_games, shown, answered, correct, wrong,
		right_percent, take_percent FROM stats WHERE found = 1${only}`).all(...target.params);
	const update = db.prepare('UPDATE stats SET level = ? WHERE package_id = ?');

	let changed = 0;

	for (const row of rows) {
		const level = toLevel({
			startedGames: row.started_games,
			shown: row.shown,
			takePercent: row.take_percent,
			// Без доли правильных ответов пересчёт терял ступень за неточные ответы
			// и расходился с тем, что считает db.js при запуске
			rightPercent: row.right_percent,
		});

		update.run(level, row.package_id);

		if (level !== null) {
			changed++;
		}
	}

	say('recalc', `уровни: обработано ${rows.length}, оценку получили ${changed}`);
}

/**
 * Пак, который весь про это: вес названного, стоящего в КАЖДОЙ теме пака,
 * поднимается до всего пака.
 *
 * Обычно вес названного в ответах считает разметка (см. countNamed в topics.js),
 * и пересчитать её без модели нельзя: в базе от разметки остались одни готовые
 * числа, а какое имя в какой теме прозвучало, не записано нигде. Один случай
 * всё же считается точно, и это как раз тот, ради которого правило и заведено:
 * названное стоит во ВСЕХ темах пака. Тогда темы, которыми оно занято, — это все
 * темы, и вопросов в них ровно столько, сколько вопросов в паке. Гадать не о чем.
 *
 * Ради этого случая правило и меняли. Пак 14934 («Для потных любителей
 * War Thunder») — семнадцать тем, War Thunder назван в каждой; семнадцать
 * упоминаний по вопросу дали 19% пака, и «пак по War Thunder» порога не взял.
 * Так же терялись «Знатокам соулслайков» (25 тем из 25) и «Книжные персонажи
 * вселенной Джорджа Мартина» (12 из 12).
 *
 * Неполное покрытие — четыре пятых тем, но не все — здесь не трогается нарочно.
 * Там точного ответа нет: какие именно темы заняты, неизвестно, а вопросов
 * в темах разное число. Такой пак дождётся модели и посчитается как следует
 * (см. subjectThemeShare в src/settings.js).
 */
function wholePack(row, item) {
	const themes = row.theme_count ?? 0;
	const questions = row.question_count ?? 0;

	if (item.kind === 'area' || themes < config.franchiseMinThemes
		|| item.themes !== themes || (item.questions ?? 0) >= questions) {
		return item;
	}

	return { ...item, questions, share: 1 };
}

/** Пересчитывает ярлыки паков по сохранённым долям — нужен после правки порога. */
function recalcTopics() {
	const target = targetSql();
	const rows = db.prepare(`SELECT p.id, p.topic_shares, p.question_count, p.theme_count, p.franchises,
			p.genre_topic, p.form_topic, p.other_kinds
		FROM packages p WHERE p.topics_at IS NOT NULL${target.where}`).all(...target.params);
	const update = db.prepare('UPDATE packages SET primary_topic = ?, primary_share = ?, franchise_top = ?, franchise_top_share = ? WHERE id = ?');

	// Жанры пересчитать без модели нельзя вовсе: они считаются по разметке тем,
	// а в базе от неё остались одни доли. Поэтому у пака, сменившего тип, жанры
	// убираются, а сам пак встаёт обратно в очередь к модели (topics_version = 0):
	// жанры музыки под подписью «какой жанр аниме» — не полбеды, а прямое враньё.
	// Доли и ярлык при этом остаются на месте, и до переспроса пак выглядит как
	// прежде, только без жанров.
	const dropGenres = db.prepare(`UPDATE packages SET genres = '[]', genre_topic = NULL, topics_version = 0 WHERE id = ?`);

	// То же самое и с носителями, и по той же причине: «Сериалы 60%» в верхней
	// полоске пака, переставшего быть кинопаком, читались бы как доля манги
	const dropForms = db.prepare(`UPDATE packages SET forms = '[]', form_topic = NULL, form_coverage = NULL, topics_version = 0 WHERE id = ?`);

	// Область, повторяющая ярлык пака, из сохранённого вычищается прямо здесь,
	// не дожидаясь модели.
	//
	// Дождаться её тут нельзя по времени: суточного лимита хватает на сотни
	// паков при базе в тысячи, и «Cinema», «Movies», «Games» и «Erudition»
	// простояли бы в списке «Пак целиком про одно» ещё месяцы — четырьмя
	// строками по полсотни паков в каждой, ничего не говорящими о паках.
	// А сказать про них нечего и по существу: «пак целиком про кино» — это
	// в точности кинопак, ярлык которого стоит рядом (см. NOT_AREAS
	// в franchise.js). Английские названия оттуда же и той же природы.
	//
	// Переспрашивать модель ради этого не надо: убирается лишняя строка,
	// а не считается новая, — и убрать её можно по тому, что уже записано.
	// Доля повторов пересчитывается вместе со списком: она из него и считается,
	// и разойдись они — галочка «мало повторов» отбирала бы по вчерашнему списку
	const rewriteFranchises = db.prepare('UPDATE packages SET franchises = ?, repeat_share = ? WHERE id = ?');

	let labelled = 0;
	let dropped = 0;
	let cleaned = 0;
	// Паки, у которых предмет занял весь пак: до правила он весил упоминаниями
	// и порога «пака про одно» не брал (см. wholePack)
	let whole = 0;

	for (const row of rows) {
		const shares = jsonOrDefault(row.topic_shares, null);
		// Виды «прочего» уже посчитаны и лежат в базе: по ним пак, который весь
		// про спорт, получает свой ярлык, не дожидаясь модели
		const { topic, share } = toPrimary(shares, row.question_count ?? 0, jsonOrDefault(row.other_kinds, []));

		const stored = jsonOrDefault(row.franchises, []);
		// Проверяется по названию, а не по виду записи. Вид («область» или
		// «произведение») появился не сразу, и у записей постарше его нет вовсе;
		// а главное — модель кладёт «Games» и «Movies» в оба поля одинаково,
		// и произведением такое не становится (см. isCategoryName в franchise.js)
		const shrunk = stored.filter(f => !isCategoryName(f.name));
		const kept = shrunk.map(f => wholePack(row, f));

		if (JSON.stringify(kept) !== JSON.stringify(stored)) {
			rewriteFranchises.run(JSON.stringify(kept), repeatShare(kept, config.subjectPackShare), row.id);

			if (shrunk.length !== stored.length) {
				cleaned++;
			}

			if (kept.some((item, at) => item !== shrunk[at])) {
				whole++;
			}
		}

		// Сами франшизы пересчитать без модели нельзя — она называет их по темам, —
		// но какая из сохранённых главная, видно и так
		const top = kept
			.filter(f => f.themes >= config.franchiseMinThemes)
			.sort((a, b) => b.questions - a.questions)[0] ?? null;

		update.run(topic, share, top?.name ?? null, top?.share ?? null, row.id);

		// «Солянка» и «Другое» ярлыком не считаются: первая говорит «намешано»,
		// второе — «размечать нечего», и ни то, ни другое не про содержимое
		if (topic && topic !== 'mixed' && topic !== MISC_KEY) {
			labelled++;
		}

		if (row.genre_topic && row.genre_topic !== topic) {
			dropGenres.run(row.id);
			dropped++;
		}

		if (row.form_topic && row.form_topic !== topic) {
			dropForms.run(row.id);
		}
	}

	say('recalc', `тематики: обработано ${rows.length}, ярлык получили ${labelled}`
		+ `${dropped > 0 ? `, у ${dropped} сменился тип — жанры переспросим` : ''}`
		+ `${cleaned > 0 ? `, у ${cleaned} убрана область, повторявшая ярлык` : ''}`
		+ `${whole > 0 ? `, у ${whole} предмет назван во всех темах — это паки про одно` : ''}`);
}

/** Общий пересчёт по сохранённым данным: и уровни, и ярлыки. */
export function recalcAll() {
	recalcLevels();
	recalcTopics();
}
