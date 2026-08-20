// Список паков файлом: как он устроен и как из него находятся паки в базе.
//
// Списки «сыграно» и «в планах» человек ведёт не в одном месте. Дома у него
// SI-HYX с вкладкой «Поиск пакетов», где сыгранное копилось годами, здесь —
// SIFirePacks, и до сих пор перенести одно в другое было нечем: там отметка
// хранится номером строки в своей базе, тут — своим, и общего у номеров нет
// ничего. Поэтому файл обмена называет паки так, как их называет человек:
// названием и авторами. Такой список читается глазами и переживает любую
// пересборку обеих баз.
//
// Формат один на обе программы — тот же разбор написан по-питоновски
// в SI-HYX (sigstats/packlist.py), и менять их нужно вместе:
//
//   {
//     "format": "sigame-pack-list",
//     "version": 1,
//     "exportedAt": "2026-08-15T12:00:00.000Z",
//     "source": "firepacks",
//     "packages": [
//       { "name": "Аниме пак № 5", "authors": ["Бурмалда"], "list": "played",
//         "markedAt": "2026-01-02T20:00:00.000Z" }
//     ]
//   }
//
// Из полей обязательно одно — name. Всё остальное подсказки: authors помогают
// выбрать нужный пак, когда название носят несколько, list отделяет сыгранное
// от запланированного (нет поля — считается сыгранным), markedAt показывается
// в списках. Незнакомые поля читатель пропускает молча: так у формата остаётся
// куда расти, не ломая уже написанные файлы.

import { packKey, buildAuthorKey } from './keys.js';

export const LIST_FORMAT = 'sigame-pack-list';
export const LIST_VERSION = 1;

/** Куда пак попадает. Всё, что не «в планах», — сыгранное. */
export const LIST_KINDS = new Set(['played', 'planned']);

/**
 * Ключ названия — ровно та его половина, что лежит в packages.match_key
 * до перевода строки (см. buildMatchKey в keys.js). Считается здесь, а не
 * в SQL, нарочно: LOWER() в SQLite умеет только латиницу, и русские названия
 * в базе и в файле разошлись бы.
 */
export const nameKey = name => String(name ?? '').trim().toLowerCase();

/**
 * Та же половина match_key, но со стороны базы. Отдельной колонки под неё нет
 * и не надо: match_key — это «название\nавторы», и до перевода строки в нём
 * лежит уже приведённое к нижнему регистру название.
 */
export const NAME_KEY_SQL = `SUBSTR(p.match_key, 1, INSTR(p.match_key, CHAR(10)) - 1)`;

/**
 * Записи файла в пригодном для поиска виде. Мусор пропускается молча: файл
 * человек мог править руками, и одна кривая строка не повод отказаться от
 * двухсот целых.
 *
 * @returns {{name: string, authors: string[], kind: string, markedAt: string|null}[]}
 */
export function readPackList(data) {
	const rows = Array.isArray(data) ? data : (data?.packages ?? []);
	const out = [];

	for (const row of Array.isArray(rows) ? rows : []) {
		// Совсем простой вид — просто строка с названием: такой список легко
		// набрать руками, и отказывать ему не за что
		const raw = typeof row === 'string' ? { name: row } : row;

		if (!raw || typeof raw !== 'object') {
			continue;
		}

		const name = String(raw.name ?? '').trim();

		if (!name) {
			continue;
		}

		const authors = Array.isArray(raw.authors)
			? raw.authors.map(value => String(value ?? '').trim()).filter(Boolean)
			: String(raw.authors ?? '').split(',').map(value => value.trim()).filter(Boolean);

		const kind = LIST_KINDS.has(raw.list) ? raw.list : 'played';

		out.push({ name, authors, kind, markedAt: raw.markedAt ? String(raw.markedAt) : null });
	}

	return out;
}

/**
 * Списком по столько-то: число подстановок в одном запросе не бесконечно.
 *
 * Считает потолок D1, а не SQLite: у SQLite их 999, у D1 — сто, и список
 * в две сотни паков валил заливку с «too many SQL variables». Размер общий
 * на обе половины нарочно — разойдись он, и ошибка вернулась бы ровно там,
 * где её труднее всего заметить: на сайте, а не дома.
 */
export function chunk(items, size = 90) {
	const out = [];

	for (let i = 0; i < items.length; i += size) {
		out.push(items.slice(i, i + size));
	}

	return out;
}

/**
 * Кого из базы просить: неповторяющиеся ключи названий всех записей файла.
 */
export function askedNames(entries) {
	return [...new Set(entries.map(entry => nameKey(entry.name)).filter(Boolean))];
}

/**
 * Разбор найденного: какой записи файла какой пак базы достался.
 *
 * Строки приходят одной кучей — по всем названиям сразу, потому что спрашивать
 * базу двести раз подряд не годится ни дома, ни тем более на Cloudflare. Здесь
 * куча разбирается обратно: у каждой записи своё название, и среди паков с этим
 * названием выбирается тот, у кого сошлись авторы. Не сошлись ни у кого —
 * берётся первый попавшийся: пак с таким названием в базе один-единственный
 * в подавляющем большинстве случаев, а отказаться от него из-за того, что
 * автор записан иначе, значило бы потерять запись на ровном месте.
 *
 * @param {{name: string, authors: string[], kind: string}[]} entries записи файла
 * @param {{id: number, name: string, authors: string, pack_id: string}[]} rows строки базы
 * @returns {{played: string[], planned: string[], missed: string[]}} ключи паков и что не нашлось
 */
export function matchPackList(entries, rows) {
	const byName = new Map();

	for (const row of rows) {
		const key = nameKey(row.name);
		const list = byName.get(key);

		if (list) {
			list.push(row);
		} else {
			byName.set(key, [row]);
		}
	}

	const played = new Set();
	const planned = new Set();
	const missed = [];
	// Когда в пак играли — по файлу, а не по мигу ввоза. Иначе двести отметок,
	// набранных за годы, оказывались бы поставленными все разом сегодня, и в
	// списке «сначала недавние» не осталось бы никакого порядка
	const markedAt = {};

	for (const entry of entries) {
		const candidates = byName.get(nameKey(entry.name));

		if (!candidates || candidates.length === 0) {
			missed.push(entry.name);
			continue;
		}

		const wanted = new Set(entry.authors.map(buildAuthorKey));

		const chosen = candidates.find(row => {
			if (wanted.size === 0) {
				return false;
			}

			for (const author of parseAuthors(row.authors)) {
				if (wanted.has(buildAuthorKey(author))) {
					return true;
				}
			}

			return false;
		}) ?? candidates[0];

		const key = packKey(chosen);

		(entry.kind === 'planned' ? planned : played).add(key);

		const when = Date.parse(entry.markedAt ?? '');

		if (Number.isFinite(when)) {
			markedAt[key] = when;
		}
	}

	return { played: [...played], planned: [...planned], missed, markedAt };
}

/** Авторы строки базы: в packages они лежат готовым JSON-списком. */
function parseAuthors(value) {
	if (Array.isArray(value)) {
		return value;
	}

	try {
		const parsed = JSON.parse(value ?? '[]');
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}
