// Библиотека паков поверх D1: то же, что делает src/server.js дома, но запросы
// уходят в базу Cloudflare и потому все до одного асинхронные.
//
// SQL здесь тот же, что и дома, — и это не совпадение, а требование: сложность,
// доли тематик и порядок выдачи должны считаться одинаково с обеих сторон,
// иначе один и тот же пак оказывался бы «лёгким» дома и «средним» на сайте.
// Расхождений ровно два, и оба вынужденные:
//
//   1. Поиск не кладётся во временную таблицу (её у D1 нет) — найденное
//      подставляется в запрос списком номеров, см. search.js.
//   2. Отметки «сыграно» лежат по общему ключу пака и принадлежат вошедшему,
//      а не установке: посетителей тут много, см. cf/schema.sql.

import {
	settings, thumbName, LEVELS, TOPICS, SPECIAL_NAMES, LANGUAGE_NAMES, MUSIC_KEY, OTHER_KINDS, GENRES,
	ORIGINS, ORIGIN_TOPICS, DECADE_TOPICS, DECADE_MIN,
} from '../../src/settings.js';
import { jsonOrDefault, roundsForApi, buildAuthorKey, splitAuthors, packKey, PACK_KEY_SQL } from '../../src/keys.js';
import { readPackList, matchPackList, askedNames, chunk, NAME_KEY_SQL } from '../../src/packlist.js';
import { packSlug } from '../../src/slug.js';
import { groupSubjects, subjectMatches } from '../../src/subject.js';
import { findHits, idList, rankOrder } from './search.js';

/**
 * «Самые популярные за период» — это паки, появившиеся в обсуждении не раньше
 * указанного срока, от самых играемых к самым редким. Период задаёт не окно
 * подсчёта игр (сервис статистики умеет отдавать только общее число за всё
 * время), а отсечку по времени сообщения ВК, из которого взят файл.
 */
const PERIODS = { week: 7, month: 30, quarter: 91, half: 182, year: 365 };

/** Начало периода в миллисекундах: в них же лежит vk_ts. */
const periodStart = days => Date.now() - days * 24 * 60 * 60 * 1000;

/** Период сортировки, если он выбран: sort=popular_year → 365. */
function periodOf(sortKey) {
	return sortKey.startsWith('popular_') ? PERIODS[sortKey.slice('popular_'.length)] ?? null : null;
}

/** Доля тематики из сохранённого JSON. У неразмеченных паков её нет вовсе. */
const shareOf = key => `COALESCE(json_extract(p.topic_shares, '$.${key}'), -1)`;

/**
 * Язык пака одним ключом: «ru-RU» и «ru» — это один и тот же русский, а пак,
 * в котором язык не указан нигде, попадает в unknown.
 *
 * Сперва спрашивается у модели (language_ai), потом у файла (language): поле
 * в файле ставит редактор, по умолчанию — язык системы автора, и по нему
 * половина базы числилась «без указания» (см. тот же LANG_SQL в src/server.js).
 */
const LANG_SQL = `COALESCE(NULLIF(LOWER(SUBSTR(COALESCE(NULLIF(p.language_ai, ''), p.language), 1, 2)), ''), 'unknown')`;

const SORTS = {
	// Порядковый номер строки в таблице к «новизне» отношения не имеет: паки
	// добавляются в базу в том порядке, в каком их встретил обход обсуждения.
	added: 'p.vk_ts',
	name: 'p.name COLLATE NOCASE',
	games: 'COALESCE(s.started_games, -1)',
	questions: 'COALESCE(p.question_count, -1)',
	size: 'COALESCE(p.size, -1)',
	anime: shareOf('anime'),
	manga: shareOf('manga'),
	games_share: shareOf('games'),
	movies: shareOf('movies'),
	cartoons: shareOf('cartoons'),
	books: shareOf('books'),
	comics: shareOf('comics'),
	music: shareOf(MUSIC_KEY),
	franchise: 'COALESCE(p.franchise_top_share, -1)',
	// Паки без нужного числа оценок сортировать не по чему: они уходят в конец,
	// а не притворяются нулями.
	rating: `COALESCE(CASE WHEN r.rating_count >= ${Number(settings.minRatingsForScore)} THEN r.rating_average END, -1)`,
};

/**
 * Общее начало всех запросов о паках.
 *
 * Отметка «сыграно» подшивается по общему ключу пака и по хозяину: без входа
 * туда уходит null, ничего не находится, и пак просто не отмечен. Дома для
 * этого хватало соединения по номеру строки — там отметка была одна на всех.
 *
 * Первым параметром такого запроса всегда идёт номер вошедшего.
 */
const BASE_FROM = `
	FROM packages p
	LEFT JOIN stats s ON s.package_id = p.id
	LEFT JOIN played pl ON pl.pack_key = ${PACK_KEY_SQL} AND pl.user_id = ?
	LEFT JOIN (
		SELECT pack_key, COUNT(*) AS rating_count, AVG(score) AS rating_average
		FROM ratings GROUP BY pack_key
	) r ON r.pack_key = ${PACK_KEY_SQL}
`;

/** Своя оценка пака. Отдельным подзапросом: без входа спрашивать не о чем. */
const MY_SCORE = `(SELECT score FROM ratings WHERE pack_key = ${PACK_KEY_SQL} AND user_id = ?) AS my_score`;

const PLAYED_FLAG = 'CASE WHEN pl.pack_key IS NULL THEN 0 ELSE 1 END AS played';

/**
 * Отобран ли пак на будущий вечер. Подзапросом, а не ещё одним подшиванием
 * в BASE_FROM, нарочно: BASE_FROM участвует и в счёте «найдено», и в числах
 * сложностей, а тем про запланированное знать нечего. Лишнее подшивание в них
 * означало бы лишний прочитанный столбец на каждой из пятнадцати тысяч строк —
 * а у D1 прочитанное считано по тарифу.
 */
const PLANNED_FLAG = `(SELECT 1 FROM planned pn WHERE pn.user_id = ? AND pn.pack_key = ${PACK_KEY_SQL}) AS planned`;

const STATS_FIELDS = `s.started_games, s.completed_games, s.shown, s.right_percent, s.take_percent, s.level,
	s.found AS stats_found`;

/**
 * Сколько паков у каждого автора. Число стоит на карточке рядом с именем: одно
 * дело — пак человека, который выложил тридцать штук, и совсем другое —
 * единственный пак случайного автора, и по одному имени этого не видно.
 *
 * Ответ запоминается изолятом: он одинаков для всех паков страницы, а меняется
 * только при заливке базы, то есть в лучшем случае раз в несколько дней.
 */
const AUTHOR_COUNTS_TTL = 10 * 60 * 1000;

let authorCountsCache = null;
let authorCountsAt = 0;

async function authorPackCounts(db) {
	if (authorCountsCache && Date.now() - authorCountsAt < AUTHOR_COUNTS_TTL) {
		return authorCountsCache;
	}

	const { results } = await db.prepare(`
		SELECT a.author_key, COUNT(DISTINCT ${PACK_KEY_SQL}) AS c
		FROM pack_authors a JOIN packages p ON p.id = a.package_id
		WHERE p.status = 'ok'
		GROUP BY a.author_key
	`).all();

	authorCountsCache = new Map(results.map(row => [row.author_key, row.c]));
	authorCountsAt = Date.now();
	return authorCountsCache;
}

/**
 * Типы паков «целиком про одно», сведённые к предмету: «Дота» и «Дота 2» —
 * одна строка в колонке фильтров и один отбор (см. src/subject.js). Ответ нужен
 * и колонке, и самому отбору: по названию типа надо знать, какие написания
 * в него входят.
 *
 * Меняется только при заливке базы, поэтому изолят держит его у себя так же,
 * как остальную общую часть. Обе колонки отбора лежат в указателе
 * ix_packages_ok_subject — строк этот запрос не читает.
 */
const SUBJECTS_TTL = 5 * 60 * 1000;

let subjectsCache = null;
let subjectsAt = 0;

async function subjectGroups(db) {
	if (subjectsCache && Date.now() - subjectsAt < SUBJECTS_TTL) {
		return subjectsCache;
	}

	const { results } = await db.prepare(`
		SELECT p.franchise_top AS name, COUNT(*) AS count
		FROM packages p
		WHERE p.status = 'ok' AND p.franchise_top IS NOT NULL AND p.franchise_top_share >= ?
		GROUP BY p.franchise_top
	`).bind(settings.subjectPackShare).all();

	subjectsCache = groupSubjects(results);
	subjectsAt = Date.now();
	return subjectsCache;
}

/**
 * Все типы паков «целиком про одно», без обрезки, — для отдельной страницы.
 *
 * В колонке фильтров их только сорок (см. subjectLimit), а всего сотни, и в
 * хвосте у списка всё самое любопытное — «Цивилизация», «Вархаммер», «Твин
 * Пикс». Пропав из колонки, они пропадали совсем. Считается тот же самый
 * список, что и для колонки, и лежит в той же копилке — лишней ходки в базу
 * страница не стоит.
 */
export async function getSubjects(db) {
	const subjects = await subjectGroups(db);

	return {
		subjects: subjects.map(group => ({ name: group.name, key: group.key, count: group.count })),
		subjectPackShare: settings.subjectPackShare,
		subjectLimit: settings.subjectLimit,
	};
}

function toPackage(row, counts) {
	// Подпись из файла разбирается на людей: «Vieldy,Pa4ok,Slime» — это трое,
	// и нажиматься на карточке каждый должен по отдельности. Разбор общий
	// с домашним сайтом (src/keys.js), иначе имена авторов разошлись бы
	// с ключами в pack_authors, по которым ищутся их паки.
	const authors = splitAuthors(jsonOrDefault(row.authors, []));
	const ratingCount = row.rating_count ?? 0;

	return {
		id: row.id,
		// Ключ, общий для всех копий пака: к нему привязаны оценки, отметки и ЧС
		packKey: packKey(row),
		name: row.name,
		fileName: row.file_name,
		// Название в адресе отдельной страницы пака: /pack/128-anime-pak. Правило
		// перевода общее с домашним сайтом (src/slug.js) — иначе ссылка, которой
		// поделились здесь, вела бы дома в другое место
		slug: packSlug(row.name ?? row.file_name),
		authors,
		// Сколько паков у каждого из них — по порядку, тем же списком
		authorPacks: authors.map(author => counts.get(buildAuthorKey(author)) ?? 1),
		tags: jsonOrDefault(row.tags, []),
		rounds: roundsForApi(row.rounds),
		contentStat: jsonOrDefault(row.content_stat, {}),
		authorDifficulty: row.author_difficulty,
		// Язык: тот, что назвала модель, а нет его — тот, что записан в файле
		// (см. LANG_SQL). Карточка показывает один язык и не должна знать,
		// откуда он взялся
		language: row.language_ai || row.language,
		packDate: row.pack_date,
		size: row.size,
		questionCount: row.question_count,
		roundCount: row.round_count,
		themeCount: row.theme_count,
		// Аукционы, коты в мешке и вопросы без риска. null — «пак разобран до того,
		// как их научились считать»: это не ноль, и сайт про такой пак молчит
		specialCount: row.special_count ?? null,
		specialStat: row.special_stat ? jsonOrDefault(row.special_stat, {}) : null,
		url: row.url,
		// Карточке нужен квадратик 72×72, а не заставка на весь экран. Считать копию
		// на лету здесь нечем и не нужно: обложки уезжают наверх готовыми
		// (см. scripts/build-web.js) и отдаются Cloudflare из статики, без участия
		// Worker. Имя копии — то же, что там: общий thumbName из settings.js.
		logo: row.logo_state === 'ok' && row.logo_file ? `/logos/thumb/${thumbName(row.logo_file)}` : null,
		topicShares: jsonOrDefault(row.topic_shares, {}),
		primaryTopic: row.primary_topic,
		primaryShare: row.primary_share,
		// Франшизы, к которым пак возвращается не по одному разу
		franchises: jsonOrDefault(row.franchises, []),
		// Чем оказалось «прочее»: стримеры, история, спорт — только то, чего набралось заметно
		otherKinds: jsonOrDefault(row.other_kinds, []),
		// Жанры внутри тематики: чем этот музпак отличается от соседнего.
		// genreTopic — из чьего списка эти ключи: он же называет и саму полоску
		genres: jsonOrDefault(row.genres, []),
		genreTopic: row.genre_topic,
		// Когда вышло то, из чего собран пак, и откуда оно родом. Рядом с каждой
		// разбивкой — какой частью пака она посчитана: у вопроса про столицы
		// ни года, ни происхождения нет, и полоска, собранная по одной десятой
		// пака, врала бы уверенно. Показывать её или нет, решает карточка
		decades: jsonOrDefault(row.decades, []),
		decadeCoverage: row.decade_coverage,
		origins: jsonOrDefault(row.origins, []),
		originCoverage: row.origin_coverage,
		// Чем всё это посчитано: версия правил разметки и модель, которая её делала.
		// Карточка пишет их мелко и бледно в самом низу — не ради красоты, а чтобы
		// по любому странному проценту было видно, старой ли он разметки и какой
		// моделью получен (см. TOPICS_VERSION в src/config.js)
		topicsVersion: row.topics_at ? row.topics_version : null,
		topicsModel: row.topics_model,
		summary: row.summary,
		// Кому пак: возраст промежутком и доля мужчин в процентах. Это оценка
		// модели по содержимому, а не статистика игроков, — так она и подписана
		// на карточке. Нет хотя бы одной части — не отдаём ничего: половина
		// оценки на карточке не значит ничего, а место занимает
		audience: row.audience_from != null && row.audience_to != null && row.audience_male != null
			? { from: row.audience_from, to: row.audience_to, male: row.audience_male }
			: null,
		// Имя выложившего наружу не отдаём: в интерфейсе это просто «Источник»
		vkDate: row.vk_date,
		vkTs: row.vk_ts,
		vkTopic: row.vk_topic,
		vkComment: row.vk_comment,
		commentText: row.comment_text,
		played: row.played === 1,
		// Отобран на будущий вечер. Отдельно от played нарочно: одно про прошлое,
		// другое про будущее, и пак бывает и там, и там сразу
		planned: row.planned === 1,
		// Оценки игроков — то, чего не знает статистика SIGame: она считает,
		// сколько раз пак запускали, а не понравился ли он.
		rating: {
			count: ratingCount,
			// Средний балл до порога наружу не отдаём вовсе: спрятать его на странице
			// мало — число всё равно уехало бы в браузер и нашлось бы в ответе API
			average: ratingCount >= settings.minRatingsForScore
				? Math.round(row.rating_average * 10) / 10
				: null,
			mine: row.my_score ?? null,
		},
		stats: row.stats_found === 1
			? {
				startedGames: row.started_games,
				completedGames: row.completed_games,
				// Показанные вопросы нужны сайту, чтобы объяснить, почему оценки ещё нет
				shown: row.shown,
				rightPercent: row.right_percent,
				takePercent: row.take_percent,
				level: row.level,
				levelName: row.level ? LEVELS[row.level].name : null,
				levelKey: row.level ? LEVELS[row.level].key : null,
			}
			: null,
	};
}

/**
 * Условия отбора и параметры к ним. Порядок параметров — это порядок, в котором
 * условия стоят в тексте запроса: D1 подставляет их подряд, и перестановка
 * условий местами без перестановки параметров тихо ломает выдачу.
 *
 * Сведённые типы паков приходят готовым списком, а не спрашиваются здесь: сам
 * этот разбор синхронный, а за списком надо в базу. Дома он берётся прямо тут —
 * там база под рукой и запросы к ней не асинхронные.
 *
 * @param {Array} groups сведённые типы паков (см. subjectGroups)
 */
function buildWhere(query, userId, hits, groups = []) {
	const conditions = [`p.status = 'ok'`];
	const params = [];

	// Личный чёрный список: что человек однажды спрятал, больше ему не показываем.
	// Пак прячется вместе со всеми своими копиями (ключ общий), автор — по тому же
	// ключу, по которому работает фильтр «показать паки автора».
	if (userId && query.get('showBlacklisted') !== '1') {
		conditions.push(`NOT EXISTS (
			SELECT 1 FROM blacklist b
			WHERE b.user_id = ? AND b.kind = 'pack' AND b.value = ${PACK_KEY_SQL}
		)`);
		params.push(userId);

		conditions.push(`NOT EXISTS (
			SELECT 1 FROM blacklist b
			JOIN pack_authors pa ON pa.author_key = b.value AND pa.package_id = p.id
			WHERE b.user_id = ? AND b.kind = 'author'
		)`);
		params.push(userId);
	}

	// Найденное поиском подставлено списком номеров, а не подшито таблицей:
	// см. search.js, там же и о том, почему это безопасно.
	if (hits) {
		conditions.push(`p.id IN (${idList([...hits.exact, ...hits.fuzzy])})`);
	}

	const levels = (query.get('levels') ?? '').split(',').map(v => parseInt(v, 10)).filter(Number.isFinite);

	// Выбранная сложность — это и есть ответ на вопрос «показывать ли без оценки»: нет.
	if (levels.length > 0) {
		conditions.push(`s.level IN (${levels.map(() => '?').join(',')})`);
		params.push(...levels);
	} else if (query.get('unrated') !== '1') {
		conditions.push('s.level IS NOT NULL');
	}

	// Тем можно выбрать сразу несколько: пак подходит, если у него есть хотя бы одна
	const tags = (query.get('tag') ?? '').split(',').map(t => t.trim()).filter(Boolean);

	if (tags.length > 0) {
		conditions.push(`(${tags.map(() => 'p.tags_key LIKE ?').join(' OR ')})`);
		params.push(...tags.map(t => `%|${t.toLowerCase()}|%`));
	}

	// Языков тоже можно выбрать несколько: в базе рядом лежат русские, английские
	// и паки, где язык не указан вовсе, — и выбирают обычно «мне понятные», а не один
	const languages = [...new Set((query.get('lang') ?? '').split(',').map(l => l.trim().toLowerCase()).filter(Boolean))];

	if (languages.length > 0) {
		conditions.push(`${LANG_SQL} IN (${languages.map(() => '?').join(',')})`);
		params.push(...languages);
	}

	const author = (query.get('author') ?? '').trim();

	if (author) {
		conditions.push('EXISTS (SELECT 1 FROM pack_authors a WHERE a.package_id = p.id AND a.author_key = ?)');
		params.push(buildAuthorKey(author));
	}

	// Типов пака тоже можно выбрать несколько: подходит тот, что попал хотя бы в один.
	// Условия разнородные (ярлык, его отсутствие, доля музыки), поэтому собираются
	// поштучно и склеиваются через OR.
	const topics = [...new Set((query.get('topic') ?? '').split(',').map(t => t.trim()).filter(Boolean))];

	if (topics.length > 0) {
		const parts = [];

		for (const topic of topics) {
			if (topic === 'unknown') {
				parts.push('p.primary_topic IS NULL');
			} else if (topic === MUSIC_KEY) {
				// Музыка не спорит с остальными тематиками, поэтому и фильтр по ней — не по ярлыку,
				// а по доле: аниме-пак с опенингами должен попадать и сюда тоже.
				parts.push(`(p.primary_topic IS NOT NULL AND ${shareOf(MUSIC_KEY)} >= ?)`);
				params.push(settings.musicThreshold);
			} else {
				parts.push('p.primary_topic = ?');
				params.push(topic);
			}
		}

		conditions.push(`(${parts.join(' OR ')})`);
	}

	// Все паки, где эта франшиза попала в повторы, — не только те, где она главная
	const franchise = (query.get('franchise') ?? '').trim();

	if (franchise) {
		conditions.push(`EXISTS (SELECT 1 FROM json_each(p.franchises) WHERE json_extract(value, '$.name') = ?)`);
		params.push(franchise);
	}

	// Дополнительный тип пака: пак целиком про это. Отдельно от franchise нарочно —
	// там вопрос «где эта франшиза вообще встречается», а здесь «какие паки этого
	// типа», и пак, у которого про Вархаммер две темы из тридцати, паком
	// по Вархаммеру не является (см. subjectPackShare).
	//
	// Написаний у типа бывает несколько: «Дота» и «Дота 2» — один тип, и нажатие
	// на него обязано показать паки по обоим (см. src/subject.js).
	const subject = (query.get('subject') ?? '').trim();

	if (subject) {
		const names = subjectMatches(groups, subject);
		conditions.push(`p.franchise_top IN (${names.map(() => '?').join(',')}) AND p.franchise_top_share >= ?`);
		params.push(...names, settings.subjectPackShare);
	}

	if (query.get('hidePlayed') === '1') {
		conditions.push('pl.pack_key IS NULL');
	}

	if (query.get('onlyPlayed') === '1') {
		conditions.push('pl.pack_key IS NOT NULL');
	}

	// Запланированное отбирается тут же, рядом с сыгранным: «что мы собирались
	// сыграть» — тот же вопрос к своим отметкам, только про будущее. Подзапросом,
	// а не подшиванием, по той же причине, что и PLANNED_FLAG.
	if (userId && query.get('onlyPlanned') === '1') {
		conditions.push(`EXISTS (SELECT 1 FROM planned pn WHERE pn.user_id = ? AND pn.pack_key = ${PACK_KEY_SQL})`);
		params.push(userId);
	}

	// Отсечка по времени появления в обсуждении живёт здесь, а не в сортировке:
	// иначе счётчик «найдено» считал бы паки, которых в выдаче нет.
	const period = periodOf(query.get('sort') ?? 'added');

	if (period) {
		conditions.push('p.vk_ts IS NOT NULL AND p.vk_ts >= ?');
		params.push(periodStart(period));
	}

	return { where: conditions.join(' AND '), params };
}

/**
 * Сколько паков каждой сложности осталось при нынешних фильтрах. Числа стоят
 * в колонке слева, и общие по базе там врали: выбрав «Аниме», человек видел
 * «Лёгких — 812», а в выдаче их оказывалось четырнадцать.
 *
 * Сама сложность из подсчёта выброшена нарочно: иначе у выбранного уровня
 * стояло бы его же число, а у остальных — нули, и переключиться было бы не на что.
 */
function levelsQuery(db, query, userId, hits, groups) {
	const asked = new URLSearchParams(query);
	asked.delete('levels');
	asked.set('unrated', '1');

	const { where, params } = buildWhere(asked, userId, hits, groups);

	return db.prepare(`
		SELECT s.level AS level, COUNT(*) AS c
		${BASE_FROM}
		WHERE ${where} AND s.level IS NOT NULL
		GROUP BY s.level
	`).bind(userId, ...params);
}

/**
 * Числа «найдено» и «сколько какой сложности» при этих фильтрах.
 *
 * Их приходится считать по всей отобранной части базы — двадцатью четырьмя
 * строками выдачи тут не обойтись, — и это самое дорогое, что делает сайт:
 * сама выдача берёт из указателя два десятка строк, а эти два счёта проходят
 * по всем, сколько бы их ни было. На пятнадцати тысячах паков одно открытие
 * главной страницы читает из-за них десятки тысяч строк, а у D1 прочитанные
 * строки — расход по тарифу, и упирается сайт в них гораздо раньше, чем
 * в число самих обращений.
 *
 * Спасает то, что база меняется только при заливке, а фильтры у большинства
 * одни и те же: главная страница без фильтров — это один и тот же счёт для
 * всех и на весь день. Поэтому ответ на каждый набор фильтров изолят держит
 * у себя те же пять минут, что и остальную общую часть.
 *
 * Вошедшим счёт не запоминается вовсе. У них в отборе участвует личное —
 * чёрный список и отметки «сыграно», — и общая копилка показала бы одному
 * человеку числа другого. Их запросы считаются каждый раз заново.
 */
const COUNTS_TTL = 5 * 60 * 1000;

/** Сколько разных наборов фильтров помним. Дальше вытесняется самый старый. */
const COUNTS_MAX = 200;

const countsCache = new Map();

function cachedCounts(key) {
	if (!key) {
		return null;
	}

	const found = countsCache.get(key);

	if (!found || Date.now() - found.at > COUNTS_TTL) {
		return null;
	}

	return found.value;
}

function rememberCounts(key, value) {
	if (!key) {
		return;
	}

	// Map хранит ключи в порядке добавления, поэтому самый старый — первый.
	if (countsCache.size >= COUNTS_MAX) {
		countsCache.delete(countsCache.keys().next().value);
	}

	countsCache.set(key, { at: Date.now(), value });
}

export async function listPackages(db, query, userId) {
	// Поиск считается в памяти: он прощает опечатки, а такое сравнение SQL не умеет.
	// Сведённые типы паков нужны отбору, но спрашиваются заранее: сам разбор условий
	// синхронный, а тут за списком надо в базу.
	const [hits, groups] = await Promise.all([
		findHits(db, query.get('search') ?? ''),
		subjectGroups(db),
	]);

	const { where, params } = buildWhere(query, userId, hits, groups);

	const sortKey = query.get('sort') ?? 'added';
	const direction = query.get('dir') === 'asc' ? 'ASC' : 'DESC';

	let orderBy;

	if (periodOf(sortKey)) {
		orderBy = `${SORTS.games} ${direction}`;
	} else if (sortKey === 'added') {
		// Паки с неразобранным временем сообщения уходят в конец при любом
		// направлении: у «сначала новые» им места нет ни с той, ни с другой стороны.
		//
		// NULLS LAST вместо прежнего первого условия «p.vk_ts IS NULL» — порядок
		// тот же, а цена другая, и здесь она важнее, чем дома: выражение перед
		// сортировкой не давало взять порядок из указателя, и база складывала
		// в память все подходящие паки целиком, чтобы отдать двадцать четыре.
		// В D1 такие строки не просто время — они считаются по тарифу, и главная
		// страница на пятнадцати тысячах паков читала бы их все при каждом открытии.
		orderBy = `${SORTS.added} ${direction} NULLS LAST`;
	} else if (sortKey === 'relevance') {
		// Порядок задаёт сам поиск (см. ниже), а внутри одной ступени совпадения
		// паки идут как обычно — сначала новые. Без поиска сортировать не по чему.
		orderBy = `${SORTS.added} DESC NULLS LAST`;
	} else if (sortKey === 'difficulty') {
		// Сложность — это доля вопросов, на которые решились ответить: чем она ниже, тем пак труднее
		orderBy = `s.take_percent ${direction === 'DESC' ? 'ASC' : 'DESC'} NULLS LAST`;
	} else {
		orderBy = `${SORTS[sortKey] ?? SORTS.added} ${direction}`;
	}

	// Паки, найденные с прощённой опечаткой, идут после точных попаданий,
	// а внутри каждой группы сохраняется выбранная сортировка.
	//
	// «По совпадению с запросом» добавляет к этому ступень названия: пак, который
	// так и называется, стоит выше пака, у которого те же слова попались в описании
	// (см. rankEntry в src/fuzzy.js). Любая другая сортировка ступень не смотрит.
	if (hits) {
		const exactFirst = `(CASE WHEN p.id IN (${idList(hits.exact)}) THEN 0 ELSE 1 END)`;
		const byName = sortKey === 'relevance' ? rankOrder(hits) : null;

		orderBy = byName ? `${byName}, ${exactFirst}, ${orderBy}` : `${exactFirst}, ${orderBy}`;
	}

	const pageSize = Math.min(Math.max(parseInt(query.get('pageSize') ?? '24', 10) || 24, 1), 100);
	const page = Math.max(parseInt(query.get('page') ?? '1', 10) || 1, 1);
	const offset = (page - 1) * pageSize;

	const listQuery = db.prepare(`
		SELECT p.*, ${STATS_FIELDS}, ${PLAYED_FLAG},
			r.rating_count, r.rating_average, ${MY_SCORE}, ${PLANNED_FLAG}
		${BASE_FROM}
		WHERE ${where}
		ORDER BY ${orderBy}, p.id DESC
		LIMIT ? OFFSET ?
	`).bind(userId, userId, userId, ...params, pageSize, offset);

	// Ключ счёта — сам отбор, а не адрес страницы: и «где» со своими значениями
	// решает всё. Страница, размер страницы и порядок в него не входят нарочно —
	// от них числа не меняются, а листающий выдачу человек попадает в уже
	// посчитанное вместо того, чтобы пересчитывать базу на каждой странице.
	const countsKey = userId ? null : JSON.stringify([where, params]);
	let counted = cachedCounts(countsKey);

	let rows;

	if (counted) {
		// Считать нечего — остаётся сама выдача, и это ровно те двадцать четыре
		// строки, которые уедут человеку.
		rows = await listQuery.all();
	} else {
		// Три запроса разом: D1 живёт за сетью, и три отдельные ходки туда заметны
		// глазом там, где дома всё считалось в одном процессе.
		const [total, list, levels] = await db.batch([
			db.prepare(`SELECT COUNT(*) AS c ${BASE_FROM} WHERE ${where}`).bind(userId, ...params),
			listQuery,
			levelsQuery(db, query, userId, hits, groups),
		]);

		const levelCounts = {};

		for (const row of levels.results) {
			levelCounts[row.level] = row.c;
		}

		counted = { total: total.results[0].c, levels: levelCounts };
		rememberCounts(countsKey, counted);
		rows = list;
	}

	const counts = await authorPackCounts(db);

	return {
		total: counted.total,
		page,
		pageSize,
		levels: counted.levels,
		packages: rows.results.map(row => toPackage(row, counts)),
	};
}

/**
 * Один пак по номеру строки — для его отдельной страницы (/pack/…).
 *
 * Поля те же самые, что и в выдаче: страница пака рисуется той же карточкой,
 * и недостающее поле обернулось бы там пустым местом посреди готовой вёрстки.
 * Чёрный список здесь не применяется нарочно: спрятанный пак пропадает из выдачи,
 * но по прямой ссылке открываться должен — иначе она выглядит битой.
 */
export async function getPackage(db, id, userId) {
	if (!Number.isFinite(id)) {
		return null;
	}

	const row = await db.prepare(`
		SELECT p.*, ${STATS_FIELDS}, ${PLAYED_FLAG},
			r.rating_count, r.rating_average, ${MY_SCORE}, ${PLANNED_FLAG}
		${BASE_FROM}
		WHERE p.id = ? AND p.status = 'ok'
	`).bind(userId, userId, userId, id).first();

	return row ? toPackage(row, await authorPackCounts(db)) : null;
}

/**
 * Все паки для карты сайта: только то, из чего складывается адрес и дата.
 *
 * Пятнадцать тысяч строк за раз — самый большой запрос, который тут вообще есть,
 * и платить за него каждым обращением поисковика нельзя. Поэтому ответ лежит
 * в кэше Cloudflare сутки (см. cf/src/index.js): карта меняется не чаще, чем
 * заливается база, то есть раз в ночь.
 */
export async function listSitemap(db) {
	const { results } = await db.prepare(`
		SELECT id, name, file_name, vk_ts FROM packages WHERE status = 'ok' ORDER BY id
	`).all();

	return results.map(row => ({ id: row.id, name: row.name ?? row.file_name, vk_ts: row.vk_ts }));
}

/**
 * Всё, что не зависит от того, кто спрашивает: списки тем, языков, франшиз
 * и числа по базе. Меняется только при заливке базы, поэтому изолят держит
 * готовый ответ у себя — иначе каждое открытие страницы стоило бы десятка
 * запросов, обходящих всю таблицу.
 */
const FACETS_TTL = 5 * 60 * 1000;

let facetsCache = null;
let facetsAt = 0;

export async function getFacets(db) {
	if (facetsCache && Date.now() - facetsAt < FACETS_TTL) {
		return facetsCache;
	}

	// Типы паков спрашиваются отдельно от общей пачки: их ответ нужен не только
	// колонке фильтров, но и самому отбору, и лежит он в своей копилке
	// (см. subjectGroups) — в общую пачку такое не сложить. Но и ждать его
	// по очереди незачем: обе ходки уходят разом.
	const [subjects, [tagRows, levelRows, topicRows, unknownTopic, musicTopic, languageRows, totals]] =
		await Promise.all([subjectGroups(db), db.batch([
			db.prepare(`SELECT tags FROM packages WHERE status = 'ok'`),
			db.prepare('SELECT level, COUNT(*) AS c FROM stats WHERE level IS NOT NULL GROUP BY level'),
			db.prepare(`
				SELECT primary_topic, COUNT(*) AS c FROM packages
				WHERE status = 'ok' AND primary_topic IS NOT NULL GROUP BY primary_topic
			`),
			db.prepare(`SELECT COUNT(*) AS c FROM packages WHERE status = 'ok' AND primary_topic IS NULL`),
			// Музыкальных считаем по доле, а не по ярлыку: у аниме-пака с опенингами
			// ярлык будет «Аниме-пак», но в музыкальные он попасть должен.
			db.prepare(`
				SELECT COUNT(*) AS c FROM packages p
				WHERE p.status = 'ok' AND p.primary_topic IS NOT NULL AND ${shareOf(MUSIC_KEY)} >= ?
			`).bind(settings.musicThreshold),
			// Языки паков. Там, где язык не указан, стоит unknown — таких паков
			// в базе заметная часть, и прятать их из фильтра нельзя.
			db.prepare(`
				SELECT ${LANG_SQL} AS lang, COUNT(*) AS c
				FROM packages p WHERE p.status = 'ok'
				GROUP BY lang ORDER BY c DESC
			`),
			db.prepare(`
				SELECT
					(SELECT COUNT(*) FROM packages WHERE status = 'ok') AS total,
					(SELECT COUNT(*) FROM stats WHERE level IS NOT NULL) AS rated,
					(SELECT COUNT(*) FROM packages WHERE status = 'ok' AND vk_ts IS NOT NULL) AS dated
			`),
		])]);

	// Теги в паках пишут кто как: «Аниме», «аниме», «anime». Считаем их одним и тем же
	// и показываем то написание, которое встречается чаще.
	const groups = new Map();

	for (const row of tagRows.results) {
		for (const tag of jsonOrDefault(row.tags, [])) {
			const key = tag.trim().toLowerCase();

			if (!key) {
				continue;
			}

			let group = groups.get(key);

			if (!group) {
				group = { count: 0, spellings: new Map() };
				groups.set(key, group);
			}

			group.count++;
			group.spellings.set(tag, (group.spellings.get(tag) ?? 0) + 1);
		}
	}

	const tagCounts = new Map();

	for (const group of groups.values()) {
		const [best] = [...group.spellings.entries()].sort((a, b) => b[1] - a[1]);
		tagCounts.set(best[0], group.count);
	}

	const levelCounts = {};

	for (const row of levelRows.results) {
		levelCounts[row.level] = row.c;
	}

	const topicCounts = {};

	for (const row of topicRows.results) {
		topicCounts[row.primary_topic] = row.c;
	}

	topicCounts.unknown = unknownTopic.results[0].c;
	topicCounts[MUSIC_KEY] = musicTopic.results[0].c;

	facetsCache = {
		tags: [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
		languages: languageRows.results.map(row => ({
			key: row.lang,
			name: LANGUAGE_NAMES[row.lang] ?? row.lang.toUpperCase(),
			count: row.c,
		})),
		specialNames: SPECIAL_NAMES,
		levels: levelCounts,
		levelNames: LEVELS,
		topics: topicCounts,
		topicNames: TOPICS,
		topicThreshold: settings.topicThreshold,
		musicThreshold: settings.musicThreshold,
		total: totals.results[0].total,
		rated: totals.results[0].rated,
		minGames: settings.minGamesForDifficulty,
		// Второй порог оценки: одних игр мало, по паку ещё должно быть показано
		// столько вопросов. Без него сайт обещал оценку, которая не появлялась.
		minShown: settings.minShownForDifficulty,
		thresholds: settings.difficultyThresholds,
		// Доля правильных ответов, ниже которой пак считается ступенью сложнее
		hardRight: settings.hardRightPercent,
		franchiseMinThemes: settings.franchiseMinThemes,
		franchiseDominantShare: settings.franchiseDominantShare,
		// Дополнительные типы паков и порог, с которого пак считается паком про одно.
		// key — то же название латиницей и без номера части: по нему в колонке
		// фильтров находится «Дота», когда набирают «dota»
		subjects: subjects.slice(0, settings.subjectLimit)
			.map(group => ({ name: group.name, key: group.key, count: group.count })),
		subjectPackShare: settings.subjectPackShare,
		// Пак про одну вселенную: с этой доли ярлык называет её прямо — «Кинопак (Гарри Поттер)»
		universePackShare: settings.universePackShare,
		// Виды «прочего» и порог, с которого их стоит называть вслух: «Прочее: стримеры, история»
		otherKindNames: OTHER_KINDS,
		otherKindShare: settings.otherKindShare,
		// Жанры внутри тематики и порог, с которого жанр стоит называть: из них
		// собирается третья полоска карточки — «какой жанр музыки»
		genreNames: GENRES,
		genreShare: settings.genreShare,
		// Полоска «когда это вышло» и полоска «откуда это»: имена кусков и то,
		// какой части пака должно хватить, чтобы их вообще показывать
		// (см. decadeCoverage в settings.js). Списки типов паков — про то, у кого
		// вопрос осмысленный: десятилетия у солянки и происхождение у аниме
		// не значат ничего. originShare — с какой доли кусок называется словами:
		// кусков в полоске шесть, и подписывать все — значит писать про одну песню
		originNames: ORIGINS,
		originTopics: ORIGIN_TOPICS,
		originShare: settings.originShare,
		originCoverage: settings.originCoverage,
		decadeTopics: DECADE_TOPICS,
		decadeCoverage: settings.decadeCoverage,
		decadeMin: DECADE_MIN,
		// Собирать базу тут нечем: ни страницы обновления, ни ссылки на неё
		readOnly: true,
		playerUri: settings.playerUri,
		// Прятать и отмечать без входа здесь нельзя: посетителей много, и список
		// без хозяина оказался бы общим — один спрятал, у всех пропало
		localBlacklist: false,
		minRatings: settings.minRatingsForScore,
		// Паки, у которых не разобралось время сообщения ВК, в подборки «за период»
		// не попадают — сайт пишет, скольких это касается.
		datedPackages: totals.results[0].dated,
	};

	facetsAt = Date.now();
	return facetsCache;
}

/**
 * Топ авторов по числу игр. Считается по статистике SIGame: сколько раз запускали
 * паки этого автора — всего, а не «сколько раз запускали за период». Окно подсчёта
 * игр сервис статистики отдавать не умеет вовсе, поэтому период здесь означает
 * ровно то же, что и в подборках «популярное за месяц»: берутся паки, выложенные
 * в обсуждение за этот срок, а игры у них считаются за всё время.
 */
const AUTHOR_PERIODS = { month: 30, half: 182, year: 365, all: null };

export async function getTopAuthors(db, query) {
	const asked = query.get('period') ?? 'all';
	const periodKey = Object.hasOwn(AUTHOR_PERIODS, asked) ? asked : 'all';
	const days = AUTHOR_PERIODS[periodKey];

	const params = [];
	let filter = `p.status = 'ok'`;

	if (days) {
		filter += ' AND p.vk_ts IS NOT NULL AND p.vk_ts >= ?';
		params.push(periodStart(days));
	}

	// Копии одного пака сводятся к одной строке: иначе автор, чей пак выложили
	// дважды, получал бы двойной счёт игр.
	const { results } = await db.prepare(`
		WITH picked AS (
			SELECT ${PACK_KEY_SQL} AS pack_key, MIN(p.id) AS id
			FROM packages p WHERE ${filter}
			GROUP BY pack_key
		)
		SELECT a.author_key AS key, MIN(a.author) AS name,
			COUNT(*) AS packs,
			SUM(COALESCE(s.started_games, 0)) AS games,
			SUM(CASE WHEN s.found = 1 THEN 1 ELSE 0 END) AS known,
			SUM(COALESCE(p.question_count, 0)) AS questions
		FROM picked
		JOIN pack_authors a ON a.package_id = picked.id
		JOIN packages p ON p.id = picked.id
		LEFT JOIN stats s ON s.package_id = picked.id
		GROUP BY a.author_key
		ORDER BY games DESC, packs DESC, name COLLATE NOCASE
	`).bind(...params).all();

	return {
		period: periodKey,
		// Все, кто вообще подписал хоть один пак: список больше не обрывается
		// на двухстах. Ответ общий для всех и лежит в кэше Cloudflare пять минут
		// (см. cf/src/index.js), поэтому лишних чтений базы это не стоит.
		total: results.length,
		authors: results.map((row, index) => ({
			place: index + 1,
			name: row.name,
			packs: row.packs,
			games: row.games,
			// У скольких паков автора статистика вообще нашлась: остальные считаются
			// нулём игр, и без этого числа ноль выглядел бы как «в них не играют»
			known: row.known,
			questions: row.questions,
		})),
	};
}

/**
 * Отмечает пак сыгранным или снимает отметку. Наружу приходит номер строки,
 * как и дома, а ложится отметка по общему ключу пака — то есть сразу на все
 * его копии. Дома то же самое делалось перебором копий (twinPackages);
 * здесь достаточно не искать копии вовсе.
 */
// ————— список паков файлом —————
//
// Двойник matchList/namePacks из src/server.js. Разбор файла и выбор пака среди
// однофамильцев там и тут общие (см. src/packlist.js) — разное только то, как
// спрашивается база: у D1 всё асинхронно и запросы идут пачкой.

/**
 * Что из принесённого файла нашлось в базе. Отвечает ключами паков — отмечает
 * потом обычный /api/played, по тем же правилам, что и всегда.
 */
export async function matchList(db, data) {
	const entries = readPackList(data);
	const names = askedNames(entries);

	if (names.length === 0) {
		return { total: 0, played: [], planned: [], missed: [] };
	}

	const parts = chunk(names);

	const results = await db.batch(parts.map(part => db.prepare(`
		SELECT p.id, p.name, p.authors, p.pack_id
		FROM packages p
		WHERE p.status = 'ok' AND ${NAME_KEY_SQL} IN (${part.map(() => '?').join(',')})
	`).bind(...part)));

	const rows = results.flatMap(result => result.results ?? []);

	return { total: entries.length, ...matchPackList(entries, rows) };
}

/** Обратный ход: по ключам паков — их названия и авторы, для вывоза списка в файл. */
export async function namePacks(db, keys) {
	const wanted = [...new Set((keys ?? []).map(value => String(value ?? '')).filter(Boolean))].slice(0, 5000);

	if (wanted.length === 0) {
		return [];
	}

	const results = await db.batch(chunk(wanted).map(part => db.prepare(`
		SELECT p.name, p.authors, ${PACK_KEY_SQL} AS pack_key
		FROM packages p
		WHERE p.status = 'ok' AND ${PACK_KEY_SQL} IN (${part.map(() => '?').join(',')})
		GROUP BY pack_key
	`).bind(...part)));

	return results.flatMap(result => result.results ?? []).map(row => ({
		key: row.pack_key,
		name: row.name,
		authors: jsonOrDefault(row.authors, []),
	}));
}

export async function setPlayed(db, userId, id, played) {
	const row = await db.prepare(`SELECT ${PACK_KEY_SQL} AS pack_key FROM packages p WHERE p.id = ?`)
		.bind(id).first();

	if (!row) {
		return { error: 'Такого пака нет' };
	}

	if (played) {
		// Сыграли — значит, «собираемся сыграть» кончилось само собой. Обе записи
		// одним заходом: D1 живёт за сетью, и две ходки туда там дороже, чем дома.
		await db.batch([
			db.prepare('INSERT OR REPLACE INTO played (user_id, pack_key, marked_at) VALUES (?, ?, ?)')
				.bind(userId, row.pack_key, Date.now()),
			db.prepare('DELETE FROM planned WHERE user_id = ? AND pack_key = ?').bind(userId, row.pack_key),
		]);
	} else {
		await db.prepare('DELETE FROM played WHERE user_id = ? AND pack_key = ?')
			.bind(userId, row.pack_key).run();
	}

	return { id, played: Boolean(played), affected: 1 };
}

/**
 * То же самое, но сразу по ключам паков. Нужно переносу отметок, сделанных
 * до входа: без учётной записи они лежат в самом браузере (см. web/app.js),
 * и в тот миг, когда хозяин у них появляется, все разом переезжают в базу.
 *
 * Номера строк для этого не годятся: браузер помнит паки по общему ключу,
 * а номера меняются при каждой заливке базы.
 *
 * Этим же приезжает список из файла, и у него есть своё время: `times` —
 * карта «ключ → когда». Отметке из файла сегодняшнее время не подходит —
 * иначе накопленное за годы оказывалось бы поставленным всё разом сегодня.
 */
export async function setPlayedKeys(db, userId, keys, played, times = {}) {
	const list = [...new Set((keys ?? []).map(key => String(key ?? '').trim()).filter(Boolean))].slice(0, 2000);

	if (list.length === 0) {
		return { affected: 0 };
	}

	const now = Date.now();

	const statements = played
		? list.map(key => db.prepare('INSERT OR REPLACE INTO played (user_id, pack_key, marked_at) VALUES (?, ?, ?)')
			.bind(userId, key, times[key] ?? now))
		: list.map(key => db.prepare('DELETE FROM played WHERE user_id = ? AND pack_key = ?').bind(userId, key));

	await db.batch(statements);

	return { affected: list.length, played: Boolean(played) };
}

/**
 * Отмечен ли пак сыгранным. Спрашивается перед тем, как принять оценку: оценка
 * ставится только тому, во что играли, — иначе она превращается в оценку обложки.
 */
export async function isPlayedPack(db, userId, key) {
	if (!key) {
		return false;
	}

	const row = await db.prepare('SELECT 1 AS ok FROM played WHERE user_id = ? AND pack_key = ?')
		.bind(userId, key).first();

	return Boolean(row);
}

/** Сколько паков отмечено сыгранными у этого человека. Стоит счётчиком в шапке. */
export async function playedCount(db, userId) {
	if (!userId) {
		return 0;
	}

	const row = await db.prepare('SELECT COUNT(*) AS c FROM played WHERE user_id = ?').bind(userId).first();
	return row.c;
}

/** Сколько паков отложено на будущее. Тем же счётом, что и сыгранное. */
export async function plannedCount(db, userId) {
	if (!userId) {
		return 0;
	}

	const row = await db.prepare('SELECT COUNT(*) AS c FROM planned WHERE user_id = ?').bind(userId).first();
	return row.c;
}

/**
 * Отобрать пак на будущий вечер — или передумать. Всё как у отметки «сыграно»:
 * лежит по общему ключу пака, то есть накрывает все его копии разом.
 */
export async function setPlanned(db, userId, id, planned) {
	const row = await db.prepare(`SELECT ${PACK_KEY_SQL} AS pack_key FROM packages p WHERE p.id = ?`)
		.bind(id).first();

	if (!row) {
		return { error: 'Такого пака нет' };
	}

	if (planned) {
		await db.prepare('INSERT OR REPLACE INTO planned (user_id, pack_key, marked_at) VALUES (?, ?, ?)')
			.bind(userId, row.pack_key, Date.now()).run();
	} else {
		await db.prepare('DELETE FROM planned WHERE user_id = ? AND pack_key = ?')
			.bind(userId, row.pack_key).run();
	}

	return { id, planned: Boolean(planned), affected: 1 };
}

/**
 * То же самое сразу по ключам: этим переезжают отметки, сделанные до входа,
 * и этим же приезжает список из файла (см. markedAt в setPlayedKeys).
 */
export async function setPlannedKeys(db, userId, keys, planned, times = {}) {
	const list = [...new Set((keys ?? []).map(key => String(key ?? '').trim()).filter(Boolean))].slice(0, 2000);

	if (list.length === 0) {
		return { affected: 0 };
	}

	const now = Date.now();

	const statements = planned
		? list.map(key => db.prepare('INSERT OR REPLACE INTO planned (user_id, pack_key, marked_at) VALUES (?, ?, ?)')
			.bind(userId, key, times[key] ?? now))
		: list.map(key => db.prepare('DELETE FROM planned WHERE user_id = ? AND pack_key = ?').bind(userId, key));

	await db.batch(statements);

	return { affected: list.length, planned: Boolean(planned) };
}

// ————— профиль —————
//
// Списки профиля ходят страницами, как и выдача библиотеки, и по той же самой
// причине. Пара сотен отметок — это пара сотен полных паков в одном ответе:
// описания, раунды, темы, — и страница «во что я играл» открывалась заметно
// дольше, чем страница со всей библиотекой сразу. Здесь у этого есть и вторая
// цена: у D1 прочитанные строки считаны по тарифу, а разбивке по сложностям
// и тематикам от строки нужно четыре поля, а не вся она.

/** Сколько паков на странице профиля. Столько же, сколько в библиотеке. */
const PROFILE_PAGE_SIZE = 24;

/**
 * Откуда берётся список. Сыгранное и запланированное отличаются только этим:
 * таблицей отметок и тем, что у запланированного пак бывает заодно и сыгранным
 * (сыграли, хотим ещё раз), — а у сыгранного признак «сыграно» стоит по самому
 * его происхождению.
 */
const PROFILE_LISTS = {
	played: {
		mark: 'pl',
		from: 'FROM played pl JOIN packages p ON ${KEY} = pl.pack_key',
		flags: '1 AS played',
	},
	planned: {
		mark: 'pn',
		from: 'FROM planned pn JOIN packages p ON ${KEY} = pn.pack_key'
			+ ' LEFT JOIN played pl ON pl.pack_key = pn.pack_key AND pl.user_id = pn.user_id',
		flags: '1 AS planned, CASE WHEN pl.pack_key IS NULL THEN 0 ELSE 1 END AS played',
	},
};

const profileFrom = list => PROFILE_LISTS[list].from.replace('${KEY}', PACK_KEY_SQL);

/** Номер страницы из адреса: меньше первой не бывает, буквы считаются за первую. */
const profilePageNumber = value => Math.max(1, parseInt(value ?? '1', 10) || 1);

/**
 * Страница списка. Пак, выложенный в обсуждение дважды, лежит в базе двумя
 * строками, а отметка у него одна на обе: показать надо одну карточку, а не две
 * одинаковых. Этим и занят MIN(p.id) — он не просто выбирает номер, а решает,
 * из какой строки взять остальные поля: SQLite берёт их с той строки, на которой
 * сошёлся минимум.
 */
async function profilePage(db, list, userId, page, counts) {
	const { mark, flags } = PROFILE_LISTS[list];

	const { results } = await db.prepare(`
		SELECT p.*, ${STATS_FIELDS}, ${flags}, ${mark}.marked_at AS marked_at, MIN(p.id) AS chosen_id,
			r.rating_count, r.rating_average, ${MY_SCORE}
		${profileFrom(list)}
		LEFT JOIN stats s ON s.package_id = p.id
		LEFT JOIN (
			SELECT pack_key, COUNT(*) AS rating_count, AVG(score) AS rating_average
			FROM ratings GROUP BY pack_key
		) r ON r.pack_key = ${mark}.pack_key
		WHERE p.status = 'ok' AND ${mark}.user_id = ?
		GROUP BY ${mark}.pack_key
		ORDER BY ${mark}.marked_at DESC
		LIMIT ? OFFSET ?
	`).bind(userId, userId, PROFILE_PAGE_SIZE, (page - 1) * PROFILE_PAGE_SIZE).all();

	return results.map(row => ({ ...toPackage(row, counts), markedAt: row.marked_at }));
}

/**
 * Четыре поля с каждого сыгранного пака — всё, из чего складываются числа
 * профиля. Строка целиком для этого не нужна, а весит она в сотню раз больше.
 */
async function profileFacts(db, list, userId) {
	const { mark } = PROFILE_LISTS[list];

	const { results } = await db.prepare(`
		SELECT p.question_count, p.authors, p.primary_topic, s.level, MIN(p.id) AS chosen_id
		${profileFrom(list)}
		LEFT JOIN stats s ON s.package_id = p.id
		WHERE p.status = 'ok' AND ${mark}.user_id = ?
		GROUP BY ${mark}.pack_key
	`).bind(userId).all();

	return results;
}

/** Сколько паков в списке. Нужно вкладке — число на ней стоит до того, как её открыли. */
async function profileCount(db, list, userId) {
	const { mark } = PROFILE_LISTS[list];

	const row = await db.prepare(`
		SELECT COUNT(DISTINCT ${mark}.pack_key) AS total
		${profileFrom(list)}
		WHERE p.status = 'ok' AND ${mark}.user_id = ?
	`).bind(userId).first();

	return row?.total ?? 0;
}

/**
 * Списки под вывоз файлом: название, авторы и дата отметки — ровно то, что
 * попадает в файл (см. web/profile.js). Полные паки для этого не нужны, а страниц
 * у вывоза нет: файл собирают целиком, иначе он врёт про то, во что играли.
 */
async function profileNames(db, list, userId) {
	const { mark } = PROFILE_LISTS[list];

	const { results } = await db.prepare(`
		SELECT p.name, p.file_name, p.authors, ${mark}.marked_at AS marked_at, MIN(p.id) AS chosen_id
		${profileFrom(list)}
		WHERE p.status = 'ok' AND ${mark}.user_id = ?
		GROUP BY ${mark}.pack_key
		ORDER BY ${mark}.marked_at DESC
	`).bind(userId).all();

	return results.map(row => ({
		name: row.name,
		fileName: row.file_name,
		authors: splitAuthors(jsonOrDefault(row.authors, [])),
		markedAt: row.marked_at,
	}));
}

/**
 * Профиль: всё, что известно про сыгранное. Копии одного пака считаются за один —
 * отметка ставится сразу на все, и в библиотеке они иначе двоились бы.
 */
export async function getProfile(db, userId, blacklist, query = new URLSearchParams()) {
	const empty = query.get('export') === '1'
		? { packages: [], planned: [] }
		: {
			total: 0, plannedTotal: 0, questions: 0, levels: {}, topics: {},
			pageSize: PROFILE_PAGE_SIZE, playedPage: 1, plannedPage: 1,
			planned: [], blacklist: [], favouriteAuthors: [], packages: [],
		};

	if (!userId) {
		return empty;
	}

	// Вывоз файлом спрашивает то же самое, но целиком и в двух полях: страницами
	// список сыгранного не вывезешь
	if (query.get('export') === '1') {
		const [packages, planned] = await Promise.all([
			profileNames(db, 'played', userId),
			profileNames(db, 'planned', userId),
		]);

		return { packages, planned };
	}

	const playedPage = profilePageNumber(query.get('playedPage'));
	const plannedPage = profilePageNumber(query.get('plannedPage'));

	const counts = await authorPackCounts(db);

	const [facts, plannedTotal, packages, planned] = await Promise.all([
		profileFacts(db, 'played', userId),
		profileCount(db, 'planned', userId),
		profilePage(db, 'played', userId, playedPage, counts),
		profilePage(db, 'planned', userId, plannedPage, counts),
	]);

	const levels = {};
	const topics = {};
	const authors = new Map();
	let questions = 0;

	for (const row of facts) {
		questions += row.question_count ?? 0;

		if (row.level) {
			levels[row.level] = (levels[row.level] ?? 0) + 1;
		}

		const topic = row.primary_topic ?? 'unknown';
		topics[topic] = (topics[topic] ?? 0) + 1;

		for (const author of splitAuthors(jsonOrDefault(row.authors, []))) {
			authors.set(author, (authors.get(author) ?? 0) + 1);
		}
	}

	return {
		total: facts.length,
		plannedTotal,
		questions,
		levels,
		topics,
		pageSize: PROFILE_PAGE_SIZE,
		playedPage,
		plannedPage,
		planned,
		// Личный чёрный список: показать его больше негде, а снимать оттуда
		// как-то надо — на карточках спрятанного по определению не видно
		blacklist,
		// Авторы, чьих паков сыграно больше одного: «любимые» из одного пака не выходят
		favouriteAuthors: [...authors.entries()]
			.filter(([, count]) => count > 1)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 12)
			.map(([name, count]) => ({ name, count })),
		packages,
	};
}
