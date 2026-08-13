// Как пак опознаётся и как читаются его поля.
//
// Вынесено из db.js по той же причине, что и settings.js из config.js: db.js
// открывает файл базы через node:sqlite, а на Cloudflare Workers ни файлов,
// ни node:sqlite нет — там та же база лежит в D1 (см. cf/). Ключи же обязаны
// считаться одинаково с обеих сторон: разойдись они, и оценка, поставленная
// на сайте, перестала бы находить свой пак.
//
// db.js всё это перевыпускает наружу, поэтому в самом проекте ничего
// не изменилось: как импортировали packKey из db.js, так и импортируем.

export function jsonOrDefault(value, fallback) {
	if (value === null || value === undefined) {
		return fallback;
	}

	try {
		return JSON.parse(value);
	} catch {
		return fallback;
	}
}

/**
 * Раунды из базы в едином виде. Старые записи хранят темы строками,
 * новые — объектами с числом вопросов и образцом ответов.
 */
export function normalizeRounds(value) {
	return jsonOrDefault(value, []).map(round => ({
		name: round.name ?? '',
		type: round.type ?? '',
		themes: (round.themes ?? []).map(theme => typeof theme === 'string'
			? { name: theme, questions: 0, sample: '' }
			: { name: theme.name ?? '', questions: theme.questions ?? 0, sample: theme.sample ?? '' }),
	}));
}

/** Теги в нижнем регистре одной строкой: |аниме|музыка|. Нужен для поиска без учёта регистра. */
export function buildTagsKey(tags) {
	if (!tags || tags.length === 0) {
		return '';
	}

	return `|${tags.map(t => t.trim().toLowerCase()).join('|')}|`;
}

/** Ключ, по которому пак ищется в сервисе статистики: имя + авторы. */
export function buildMatchKey(name, authors) {
	const normalizedName = (name ?? '').trim().toLowerCase();
	const normalizedAuthors = (authors ?? []).map(a => a.trim().toLowerCase()).join(',');
	return `${normalizedName}\n${normalizedAuthors}`;
}

/** Одно написание автора для сравнения: регистр, ё и лишние пробелы не важны. */
export function buildAuthorKey(author) {
	return author.trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
}

/**
 * Ключ пака, общий для всех его копий: один и тот же файл нередко выложен
 * в обсуждение не по разу, и всё, что человек про пак говорит, — отметка
 * «сыграно», оценка, чёрный список — относится к паку, а не к строке в базе.
 *
 * Берётся идентификатор из самого файла вместе с названием, а если
 * идентификатора нет — номер строки: такой пак копией ничего не считает,
 * что и правильно.
 *
 * Название в ключе стоит не для красоты. Идентификатор пака уникален только
 * на словах: автор, который делает следующий пак из старого файла, уносит
 * идентификатор с собой, и «Аниме пак № 5», «№ 6» и «№ 7» одного человека
 * оказываются одним и тем же паком. Тогда в топе авторов у него считался
 * один пак вместо четырёх, а отметка «сыграно» на одном зажигалась на всех.
 * Одинаковый идентификатор при разных названиях — это разные паки; настоящие
 * копии одного файла названы одинаково.
 *
 * Регистр не трогаем нарочно: SQLite умеет LOWER() только по латинице,
 * и русские названия здесь и в SQL-двойнике разошлись бы.
 *
 * SQL-двойник строкой ниже; менять их нужно вместе.
 */
export function packKey(row) {
	const id = (row.pack_id ?? '').trim();
	return id ? `${id}\n${(row.name ?? '').trim()}` : String(row.id);
}

export const PACK_KEY_SQL = `CASE
	WHEN COALESCE(TRIM(p.pack_id), '') = '' THEN CAST(p.id AS TEXT)
	ELSE TRIM(p.pack_id) || CHAR(10) || TRIM(COALESCE(p.name, ''))
END`;
