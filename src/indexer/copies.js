// Копии одного пака: на сайте остаётся самая ранняя выкладка.
//
// Один и тот же файл нередко выложен в обсуждение не по разу — своим автором
// заново, чужими руками, с новым названием сообщения. Копией пак признаётся
// не по имени файла, а по содержимому: сошлись автор, название, вес архива
// и сами вопросы с ответами — по отпечаткам, вопрос за вопросом.
//
// Приговоры выносятся всей библиотеке разом, поэтому шаг ждёт разбора
// и отпечатков по-настоящему, а не «кормится» ими (см. STEPS в steps.js).

import { db, buildAuthorKey } from '../db.js';
import { contentTs, decodePrints } from '../plagiarism.js';
import { say } from './progress.js';
import { targetSql } from './queue.js';

// ————— копии одного пака —————

/**
 * Насколько может разойтись вес двух копий одного пака.
 *
 * Не ноль, и это не послабление ради красоты. «Илитарные вопросы» лежат
 * в обсуждении дважды — 57 723 048 байт и 57 723 049, — и это один и тот же
 * пак, у которого поправили один вопрос: 113 отпечатков из 114 совпадают
 * дословно. Требовать побайтового равенства значило бы не заметить ни этой
 * пары, ни любой другой, прошедшей через перепаковку архива.
 */
const COPY_SIZE_SPREAD = 0.005;

/** Сколько вопросов копии разрешено разойтись: тот же счёт, что и у веса. */
const COPY_QUESTION_SPREAD = 0.03;

/**
 * Один ли это пак. Проверяется ровно то, о чём просили: автор, название, вес —
 * и сами вопросы с ответами.
 *
 * Вопросы решают, а не название с весом: название и автор совпадают у всех паков
 * серии («Chillout 14» и «Chillout 15» — разные паки одного человека одного
 * веса), и без отпечатков правило склеивало бы соседей по серии. Поэтому пак
 * без снятых отпечатков копией не объявляется никогда — про него попросту
 * неизвестно, что внутри (см. fetchPrints в src/indexer/backfill.js).
 */
function sameContent(a, b) {
	if (a.nameKey !== b.nameKey || a.authorsKey !== b.authorsKey) {
		return false;
	}

	// Отпечатки, снятые по разным правилам, не совпадают ни у кого: сравнивать
	// их между собой значит объявить разными два одинаковых пака. Пока
	// библиотека переснимается (см. PRINTS_VERSION), такая пара просто ждёт
	if (a.printsVersion !== b.printsVersion) {
		return false;
	}

	const size = Math.max(a.size ?? 0, b.size ?? 0);

	if (size > 0 && Math.abs((a.size ?? 0) - (b.size ?? 0)) / size > COPY_SIZE_SPREAD) {
		return false;
	}

	if (a.prints.size === 0 || b.prints.size === 0) {
		return false;
	}

	const total = Math.max(a.prints.size, b.prints.size);
	let common = 0;

	for (const fp of a.prints) {
		if (b.prints.has(fp)) {
			common++;
		}
	}

	// Одному-двум вопросам разойтись позволено: копию нередко выкладывают
	// с исправленной опечаткой. Доля считается от большего из двух наборов,
	// поэтому пак, у которого вопросов вдвое больше, копией не станет
	return total - common <= Math.max(1, Math.floor(total * COPY_QUESTION_SPREAD));
}

/**
 * Помечает копии паков, чтобы на сайте остался один — самый ранний.
 *
 * ————— зачем —————
 *
 * Один и тот же файл выкладывают в обсуждение по нескольку раз: перевыкладывают
 * сами авторы, перевыкладывают чужое, приносят из другого чата. В библиотеке
 * такой пак стоял столькими карточками, сколько раз его выложили, — и человек,
 * листающий выдачу, видел одно и то же по два и по три раза подряд.
 *
 * ————— почему статусом, а не отдельной колонкой —————
 *
 * Потому что «не показывать» здесь означает «не показывать нигде»: ни в списке,
 * ни в счётчиках тематик, ни в карте сайта, ни в поиске, ни в топе авторов.
 * Все эти запросы и дома, и наверху уже отбирают паки по `status = 'ok'`,
 * и отдельный признак пришлось бы вписывать в четыре десятка мест — с верным
 * шансом забыть одно. Копия получает свой статус и исчезает отовсюду разом,
 * а строка её остаётся в базе: оценки, отметки «сыграно» и запланированное
 * лежат по общему ключу пака (см. packKey в src/keys.js) и переезжают
 * на оставшийся сам собой.
 *
 * Заодно копии перестают тратить работу: шаги модели, статистики и плагиата
 * ходят по тем же `status = 'ok'`.
 *
 * ————— что считается копией —————
 *
 * То, о чём просили: совпали автор, название и вес — и совпали вопросы
 * с ответами (см. sameContent). Пак с теми же вопросами, но чужой подписью,
 * копией не считается: это плагиат, и разбирается он отдельно.
 *
 * Остаётся самый ранний — по возрасту содержимого, а не по номеру строки
 * (см. contentTs в src/plagiarism.js): пак, найденный сегодня в старой теме,
 * получает больший номер, чем прошлогодний, и судить по номерам значило бы
 * оставить на сайте не тот.
 */
export function markCopies() {
	// Сужение написано под UPDATE, поэтому и таблица названа полным именем:
	// у запроса на изменение алиаса «p» нет, и «p.id IN (…)» в нём — ошибка
	const target = targetSql('packages');

	// Разбирается вся база разом, а не названные паки: копия — это отношение
	// пака к другим, и по одному паку его не выяснить. `--packs=` здесь сужает
	// только то, кому меняется отметка
	const rows = db.prepare(`
		SELECT p.id, p.name, p.authors_key, p.size, p.question_count, p.vk_ts, p.file_ts,
			p.status, p.copy_of, q.prints, COALESCE(q.version, 1) AS prints_version
		FROM packages p LEFT JOIN pack_prints q ON q.package_id = p.id
		WHERE p.status = 'ok' OR p.status = 'copy'
		ORDER BY p.id
	`).all();

	/** Паки, у которых сошлись подпись и название: дальше сравниваются вопросы. */
	const buckets = new Map();

	/** Пак по номеру: нужен, чтобы спросить у старшего, каким видом сняты его отпечатки. */
	const byId = new Map();

	for (const row of rows) {
		const entry = {
			id: row.id,
			status: row.status,
			copyOf: row.copy_of ?? null,
			size: row.size ?? 0,
			nameKey: buildAuthorKey(row.name ?? ''),
			authorsKey: buildAuthorKey(row.authors_key ?? ''),
			ts: contentTs(row),
			printsVersion: row.prints_version,
			prints: new Set(decodePrints(row.prints, row.prints_version).byPrint.keys()),
		};

		byId.set(entry.id, entry);

		const bucket = `${entry.authorsKey}\n${entry.nameKey}`;
		const known = buckets.get(bucket);

		if (known) {
			known.push(entry);
		} else {
			buckets.set(bucket, [entry]);
		}
	}

	/** Кто чьей копией стал. Номер пака -> номер оставшегося. */
	const copies = new Map();

	for (const bucket of buckets.values()) {
		if (bucket.length < 2) {
			continue;
		}

		// Внутри корзины паки разбиваются на кучки по содержимому: под одним
		// названием одного автора лежат и настоящие копии, и просто соседи
		const groups = [];

		for (const entry of bucket) {
			const group = groups.find(items => items.every(other => sameContent(entry, other)));

			if (group) {
				group.push(entry);
			} else {
				groups.push([entry]);
			}
		}

		for (const group of groups) {
			if (group.length < 2) {
				continue;
			}

			// Остаётся самый ранний. Пак без отметки времени старшим не бывает:
			// про него неизвестно, когда он появился
			const kept = group
				.slice()
				.sort((a, b) => (a.ts ?? Infinity) - (b.ts ?? Infinity) || a.id - b.id)[0];

			for (const entry of group) {
				if (entry.id !== kept.id) {
					copies.set(entry.id, kept.id);
				}
			}
		}
	}

	const setCopy = db.prepare(`UPDATE packages SET status = 'copy', copy_of = ? WHERE id = ?${target.where}`);
	const setBack = db.prepare(`UPDATE packages SET status = 'ok', copy_of = NULL WHERE id = ?${target.where}`);

	let marked = 0;
	let freed = 0;

	for (const row of rows) {
		const keeper = copies.get(row.id) ?? null;

		if (keeper !== null && (row.status !== 'copy' || row.copy_of !== keeper)) {
			marked += setCopy.run(keeper, row.id, ...target.params).changes;
		}

		// Копия, у которой старший пак умер или которая перестала быть копией
		// после переразбора, возвращается в библиотеку сама.
		//
		// Но только если её и вправду сравнивали. Пока библиотека переснимает
		// отпечатки, пара «пак и его копия» какое-то время держит свёртки разных
		// видов, и сравнить их нечем (см. sameContent). Отпустить копию на этом
		// основании значило бы каждую ночь возвращать её в библиотеку и на
		// следующую прятать снова — а на сайте это два одинаковых пака подряд
		if (keeper === null && row.status === 'copy') {
			const owner = byId.get(row.copy_of);

			if (owner && owner.printsVersion !== (row.prints_version ?? 1)) {
				continue;
			}

			freed += setBack.run(row.id, ...target.params).changes;
		}
	}

	say('copies', `копий в базе ${copies.size}: спрятано ${marked}, возвращено ${freed}. `
		+ 'На сайте у каждого пака остаётся самая ранняя выкладка');
}
