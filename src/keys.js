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

/**
 * Раунды для сайта: только название раунда и названия тем — ровно то, что
 * карточка показывает в «Подробнее».
 *
 * Отдельно от normalizeRounds ради веса ответа. В базе у каждой темы лежит ещё
 * и образец её содержимого (`sample`) — выжимка ответов и кусков вопросов, ради
 * которой всё и затевалось: по ней модель размечает тематики и пишет краткое
 * описание (см. buildSample в src/siq.js). Показывать его негде и не за чем,
 * а весит он на страницу в две дюжины паков 126 КБ из 273 КБ всего ответа —
 * то есть почти половину выдачи браузер получал ради поля, которое ни одна
 * строчка сайта не читает. Число вопросов темы и вид раунда сайт не читает тоже.
 *
 * Индексатору и разметке достаётся полный вид: они ходят в базу, а не сюда.
 *
 * Единственное, что проезжает сквозь этот отбор кроме названия, — `src`, номер
 * пака, в котором эта тема стояла раньше (см. src/plagiarism.js). Одно число
 * на украденную тему, и стоит оно того: у солянки доноры разные, и без него
 * карточке пришлось бы либо молчать про то, откуда взята каждая тема, либо
 * возить наверх целую таблицу происхождения. Образец при этом остаётся дома
 * по-прежнему — он и есть то тяжёлое, ради чего этот отбор написан.
 */
export function roundsForApi(value) {
	return jsonOrDefault(value, []).map(round => ({
		name: round.name ?? '',
		themes: (round.themes ?? []).map(theme => {
			if (typeof theme === 'string') {
				return { name: theme };
			}

			return theme.src
				? { name: theme.name ?? '', src: theme.src }
				: { name: theme.name ?? '' };
		}),
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

// ————— составные подписи —————
//
// В поле <author> внутри пака нередко записаны сразу несколько человек, и записаны
// как придётся: «Vieldy,Pa4ok,Slime», «r1v1_666 & Wiqox & adderall», «vadim и
// бурмалда», «Бурмалда, drugs (аптека)». Для базы это была одна подпись целиком:
// нажать на неё можно было только вместе, паки Бурмалды по такой строке
// не находились, а в топе авторов каждое такое сочетание стояло отдельным
// «автором» — при том, что все его паки уже посчитаны каждому из них порознь.
//
// Разбор нарочно осторожный: где непонятно, строка остаётся целой. Лишний
// несуществующий автор в списке хуже, чем неразобранная подпись, — его паки
// потеряются, а вторую половину подписи потом не найти.

/**
 * Части, которые именем не являются: так подписывают «и все остальные».
 * Сравниваются по buildAuthorKey, поэтому пишутся здесь в нижнем регистре.
 */
const NOT_AUTHORS = new Set([
	'др', 'и др', 'другие', 'и другие', 'прочие', 'остальные', 'все',
	'etc', 'co', 'ко', 'feat', 'ft', 'и', 'and', 'хз', 'люди', 'др.',
]);

/**
 * Похоже на ссылку, а не на подпись. Такие строки не режем вовсе: косые черты
 * и точки в адресе — часть адреса, и «https://vk.com/narygrown» превратилось бы
 * в двух авторов «https:» и «vk.com».
 */
const LOOKS_LIKE_LINK = /https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|ru|tv|me|to|org|net|io)\b/i;

/**
 * Разделители перечисления. Косая черта — только с пробелами вокруг: «Tw/LastGoMer»
 * и «B()tYaR/\3I» это цельные прозвища, а «sentsuri / 86» — двое.
 *
 * Флаг y (липучий) нужен, чтобы спрашивать «стоит ли разделитель ровно здесь»,
 * а не «есть ли он где-нибудь дальше».
 */
const SEPARATORS = /\s*[,;&+]\s*|\s+\/\s+/y;

/** Союз между двумя подписями. Тоже липучий и по той же причине. */
const AND_WORD = /\s+(?:и|and)\s+/iy;

/** Сколько слов в части. По ним решается, перечисление ли это через «и». */
const wordCount = text => text.split(/\s+/).filter(Boolean).length;

/**
 * Режет по разделителям верхнего уровня: то, что в скобках, остаётся целым.
 * «bbonbon8(1-й раунд), h0b0t(2,3 раунд)» — двое, а не четверо.
 */
function splitTopLevel(text) {
	const parts = [];
	let depth = 0;
	let start = 0;

	for (let i = 0; i < text.length; i++) {
		const char = text[i];

		if (char === '(' || char === '[') {
			depth++;
			continue;
		}

		if (char === ')' || char === ']') {
			depth = Math.max(0, depth - 1);
			continue;
		}

		if (depth > 0) {
			continue;
		}

		SEPARATORS.lastIndex = i;

		if (SEPARATORS.test(text)) {
			parts.push(text.slice(start, i));
			start = SEPARATORS.lastIndex;
			i = start - 1;
		}
	}

	parts.push(text.slice(start));
	return parts;
}

/**
 * «Лиса и Помидор» — двое, а «Господи ну и дурак этот Кубик» — один. Отличаются
 * они длиной сторон: перечисляют прозвищами, а не предложениями, поэтому режем
 * только когда с обеих сторон стоит не больше двух слов.
 */
function splitByAnd(text) {
	for (let i = 0; i < text.length; i++) {
		AND_WORD.lastIndex = i;

		if (!AND_WORD.test(text)) {
			continue;
		}

		const left = text.slice(0, i).trim();
		const right = text.slice(AND_WORD.lastIndex).trim();

		if (!left || !right || wordCount(left) > 2 || wordCount(right) > 2) {
			continue;
		}

		return [left, right];
	}

	return [text];
}

/**
 * Подписи паков по одному человеку. Ничего не находит — возвращает то, что было:
 * потерять автора хуже, чем оставить составную подпись неразобранной.
 *
 * @param {string[]} authors как записано в самом файле пака
 * @returns {string[]} по имени в строке, без повторов
 */
export function splitAuthors(authors) {
	const out = [];
	const seen = new Set();

	for (const raw of authors ?? []) {
		const text = String(raw ?? '').trim();

		if (!text) {
			continue;
		}

		const pieces = LOOKS_LIKE_LINK.test(text)
			? [text]
			: splitTopLevel(text).flatMap(splitByAnd);

		for (const piece of pieces) {
			// Хвостовые точки и многоточия к имени не относятся: «NSPants и др.»
			const name = piece.trim().replace(/[.,;\s]+$/u, '').trim();
			const key = buildAuthorKey(name);

			if (!key || NOT_AUTHORS.has(key) || seen.has(key)) {
				continue;
			}

			seen.add(key);
			out.push(name);
		}
	}

	// Разобрали в ноль (подпись была из одних «и др.») — пусть остаётся как есть
	return out.length > 0 ? out : (authors ?? []).map(a => String(a).trim()).filter(Boolean);
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

const packKeySql = prefix => `CASE
	WHEN COALESCE(TRIM(${prefix}pack_id), '') = '' THEN CAST(${prefix}id AS TEXT)
	ELSE TRIM(${prefix}pack_id) || CHAR(10) || TRIM(COALESCE(${prefix}name, ''))
END`;

export const PACK_KEY_SQL = packKeySql('p.');

/**
 * Тот же ключ без имени таблицы — таким его записывают в указатель.
 *
 * Указатель по выражению SQLite заводит только на колонках самой таблицы,
 * без всяких «p.», а вот в запросе то же выражение стоит уже с именем: разбор
 * запроса сводит одно к другому, и указатель находится. Записаны они всё-таки
 * порознь, потому что порознь и читаются: одно — база, другое — запрос.
 */
export const PACK_KEY_INDEX_SQL = packKeySql('');

/**
 * Какая часть вопросов пака приходится на повторы франшиз — тем же счётом,
 * каким это число выводит карточка (см. createFranchises в web/card.js).
 *
 * Лежит готовым числом в колонке packages.repeat_share: считать его на лету
 * из сохранённого JSON выходит слишком дорого. Обход json_each по всей таблице
 * стоит четверть секунды, а колонка фильтров спрашивает его пять раз кряду —
 * полторы секунды на одно нажатие галочки, и это дома; наверху те же строки
 * ещё и считаны по тарифу D1.
 *
 * Отсюда пара «функция и её SQL-двойник», как у ключа пака строкой ниже:
 * функция считает число при разборе, SQL — при дозаливке колонки в базу,
 * созданную прежней версией (см. src/db.js). Расходиться им нельзя.
 *
 * Из счёта выброшено то же самое, что не показывает и карточка:
 *
 *   область («Футбол», «Вторая мировая») — повтором не бывает: викторина
 *     из областей и состоит, и «География ×5» о паке не говорит ничего;
 *   предмет самого пака (доля от subjectPackShare и выше) — у пака про Гарри
 *     Поттера «Гарри Поттер ×27» не наблюдение, а пересказ названия числом.
 *
 * Доли франшиз пересекаются (одна тема бывает и про то, и про это), поэтому
 * сумма изредка переваливает за единицу. Порогам это не мешает: они спрашивают
 * «много ли», а не «сколько ровно».
 *
 * @param {Array} franchises сохранённый список повторов пака
 * @param {number} own порог subjectPackShare
 */
export function repeatShare(franchises, own) {
	return (franchises ?? [])
		.filter(item => item?.kind !== 'area' && (item?.share ?? 0) < own)
		.reduce((sum, item) => sum + (item.share ?? 0), 0);
}

/**
 * SQL-двойник. Зовётся один раз — при дозаливке колонки, — и потому в нём стоит
 * имя таблицы, а не готовый псевдоним: в UPDATE псевдонима нет.
 *
 * @param {number} own порог subjectPackShare
 * @param {string} table к чьим полям обращаться
 */
export const repeatShareSql = (own, table = 'p') => `COALESCE((
	SELECT SUM(json_extract(value, '$.share'))
	FROM json_each(CASE WHEN json_valid(${table}.franchises) THEN ${table}.franchises ELSE '[]' END)
	WHERE COALESCE(json_extract(value, '$.kind'), '') <> 'area'
		AND json_extract(value, '$.share') < ${Number(own)}
), 0)`;

/**
 * Какая часть вопросов пака — спецвопросы. У пака без разобранных вопросов
 * ответа нет: делить не на что, и ноль тут означал бы «спецвопросов нет»,
 * а это другое.
 */
export const SPECIAL_SHARE_SQL = `CASE
	WHEN COALESCE(p.question_count, 0) > 0 AND p.special_count IS NOT NULL
	THEN p.special_count * 1.0 / p.question_count
END`;
