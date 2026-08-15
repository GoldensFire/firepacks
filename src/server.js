// Локальный сайт: отдаёт веб-интерфейс и небольшое JSON API поверх базы.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { config, LEVELS, TOPICS, MUSIC_KEY, SPECIAL_NAMES, LANGUAGE_NAMES, OTHER_KINDS, GENRES } from './config.js';
import {
	db, jsonOrDefault, roundsForApi, buildAuthorKey, splitAuthors, packKey, PACK_KEY_SQL, LOCAL_USER_ID,
} from './db.js';
import { readPackList, matchPackList, askedNames, chunk, NAME_KEY_SQL } from './packlist.js';
import { runSearch, warmSearch } from './search.js';
import { groupSubjects, subjectMatches } from './subject.js';
import { packSlug, packIdFromPath } from './slug.js';
import { injectPackMeta, buildSitemap, buildRobots } from './meta.js';
import {
	startUpdate, startDeploy, stopUpdate, updateState, subscribe, updateModels, UPDATE_STEPS,
} from './updater.js';
import {
	hasDiscord, redirectUri, currentUser, startLogin, finishLogin, logout,
	rate, setBlacklisted, listBlacklist,
} from './auth.js';
import { ensureThumb } from './thumbs.js';

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.ico': 'image/x-icon',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.jpe': 'image/jpeg',
	'.jfif': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.bmp': 'image/bmp',
	'.avif': 'image/avif',
};

/**
 * «Самые популярные за период» — это паки, появившиеся в обсуждении не раньше
 * указанного срока, от самых играемых к самым редким. Период задаёт не окно
 * подсчёта игр (сервис статистики умеет отдавать только общее число за всё
 * время), а отсечку по времени сообщения ВК, из которого взят файл.
 * Ключ приходит с сайта как sort=popular_<ключ>.
 */
const PERIODS = {
	week: 7,
	month: 30,
	quarter: 91,
	half: 182,
	year: 365,
};

/** Начало периода в миллисекундах: в них же лежит vk_ts. */
function periodStart(days) {
	return Date.now() - days * 24 * 60 * 60 * 1000;
}

/** Период сортировки, если он выбран: sort=popular_year → 365. */
function periodOf(sortKey) {
	return sortKey.startsWith('popular_') ? PERIODS[sortKey.slice('popular_'.length)] ?? null : null;
}

/** Доля тематики из сохранённого JSON. У неразмеченных паков её нет вовсе. */
const shareOf = key => `COALESCE(json_extract(p.topic_shares, '$.${key}'), -1)`;

/**
 * Язык пака одним ключом: «ru-RU» и «ru» — это один и тот же русский, а пак,
 * в котором язык не указан вовсе, попадает в unknown. Имена ключей живут
 * в LANGUAGE_NAMES.
 */
const LANG_SQL = `COALESCE(NULLIF(LOWER(SUBSTR(p.language, 1, 2)), ''), 'unknown')`;

const SORTS = {
	// Порядковый номер строки в таблице к «новизне» отношения не имеет: паки
	// добавляются в базу в том порядке, в каком их встретил обход обсуждения,
	// и заново разобранное старое сообщение получает номер больше свежего.
	// Новизна — это время сообщения ВК, из которого взят файл.
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
	// а не притворяются нулями — иначе «по оценке» ставило бы неоценённые
	// впереди тех, у кого оценка есть, но низкая.
	rating: `COALESCE(CASE WHEN r.rating_count >= ${Number(config.minRatingsForScore)} THEN r.rating_average END, -1)`,
};

/**
 * Сколько паков у каждого автора. Число стоит на карточке рядом с именем: одно
 * дело — пак человека, который выложил тридцать штук, и совсем другое — единственный
 * пак случайного автора, и по одному имени этого не видно.
 *
 * Копии одного пака считаются за один — как и везде, где паки пересчитываются.
 *
 * Ответ ненадолго запоминается: он одинаков для всех паков страницы, а меняется
 * только после обхода обсуждения, то есть в лучшем случае раз в несколько минут.
 */
const authorPacksQuery = db.prepare(`
	SELECT a.author_key, COUNT(DISTINCT ${PACK_KEY_SQL}) AS c
	FROM pack_authors a JOIN packages p ON p.id = a.package_id
	WHERE p.status = 'ok'
	GROUP BY a.author_key
`);

const AUTHOR_COUNTS_TTL = 30_000;
let authorCountsCache = null;
let authorCountsAt = 0;

function authorPackCounts() {
	if (!authorCountsCache || Date.now() - authorCountsAt > AUTHOR_COUNTS_TTL) {
		authorCountsCache = new Map(authorPacksQuery.all().map(row => [row.author_key, row.c]));
		authorCountsAt = Date.now();
	}

	return authorCountsCache;
}

/**
 * Типы паков «целиком про одно», сведённые к предмету: «Дота» и «Дота 2» —
 * одна строка в колонке фильтров и один отбор (см. subject.js). Считается
 * по готовой колонке franchise_top, обе колонки отбора лежат в указателе
 * ix_packages_ok_subject, поэтому строк это не читает.
 *
 * Ответ нужен и колонке фильтров, и самому отбору (по названию типа надо знать,
 * какие написания в него входят), и меняется он только при обходе обсуждения —
 * поэтому запоминается на те же полминуты, что и число паков у авторов.
 */
const subjectsQuery = db.prepare(`
	SELECT p.franchise_top AS name, COUNT(*) AS count
	FROM packages p
	WHERE p.status = 'ok' AND p.franchise_top IS NOT NULL AND p.franchise_top_share >= ?
	GROUP BY p.franchise_top
`);

const SUBJECTS_TTL = 30_000;
let subjectsCache = null;
let subjectsAt = 0;

function subjectGroups() {
	if (!subjectsCache || Date.now() - subjectsAt > SUBJECTS_TTL) {
		subjectsCache = groupSubjects(subjectsQuery.all(config.subjectPackShare));
		subjectsAt = Date.now();
	}

	return subjectsCache;
}

/**
 * Чей чёрный список применять и пополнять. Вошедшему — его собственный,
 * а без входа на своей машине список принадлежит установке: прятать паки
 * можно так же без спроса, как отмечать их сыгранными (см. config.localBlacklist).
 * На хостинге без входа хозяина нет — там прятать нечего и некому.
 */
function blacklistOwner(user) {
	if (user) {
		return user.id;
	}

	return config.localBlacklist ? LOCAL_USER_ID : null;
}

function toPackage(row) {
	// Подпись из файла разбирается на людей: «Vieldy,Pa4ok,Slime» — это трое,
	// и нажиматься на карточке каждый должен по отдельности. В самой колонке
	// подпись остаётся как есть: по ней пак ищется в статистике SIGame.
	const authors = splitAuthors(jsonOrDefault(row.authors, []));
	const ratingCount = row.rating_count ?? 0;
	const counts = authorPackCounts();

	return {
		id: row.id,
		// Ключ, общий для всех копий пака: к нему привязаны оценки и чёрный список
		packKey: packKey(row),
		name: row.name,
		fileName: row.file_name,
		// Название в адресе отдельной страницы пака: /pack/128-anime-pak. Считается
		// здесь, а не на сайте, чтобы правило перевода было одно на всех — им же
		// пользуются карта сайта и ссылка «поделиться» (см. src/slug.js)
		slug: packSlug(row.name ?? row.file_name),
		authors,
		// Сколько паков у каждого из них — по порядку, тем же списком
		authorPacks: authors.map(author => counts.get(buildAuthorKey(author)) ?? 1),
		tags: jsonOrDefault(row.tags, []),
		rounds: roundsForApi(row.rounds),
		contentStat: jsonOrDefault(row.content_stat, {}),
		authorDifficulty: row.author_difficulty,
		language: row.language,
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
		// Карточке нужен квадратик 72×72, а не заставка на весь экран, поэтому
		// сюда идёт адрес уменьшенной копии (см. thumbs.js). Оригинал никуда
		// не делся и по-прежнему лежит на /logos/<файл>.
		logo: row.logo_state === 'ok' && row.logo_file ? `/logos/thumb/${row.logo_file}` : null,
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
			average: ratingCount >= config.minRatingsForScore
				? Math.round(row.rating_average * 10) / 10
				: null,
			mine: row.my_score ?? null,
		},
		stats: row.stats_found === 1
			? {
				startedGames: row.started_games,
				completedGames: row.completed_games,
				// Показанные вопросы нужны сайту, чтобы объяснить, почему оценки ещё нет:
				// одних игр для неё мало, см. minShownForDifficulty
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

function buildWhere(query, userId) {
	const conditions = [`p.status = 'ok'`];
	const params = [];

	// Личный чёрный список: что человек однажды спрятал, больше ему не показываем.
	// Пак прячется вместе со всеми своими копиями (ключ общий), автор — по тому же
	// ключу, по которому works фильтр «показать паки автора».
	//
	// Страница управления списком просит показать спрятанное явно: иначе снять
	// пак с чёрного списка можно было бы только через профиль.
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

	// Поиск считается в JS и складывается во временную таблицу: он прощает опечатки,
	// а такое сравнение SQL не умеет. Подробности — в search.js.
	const searching = runSearch(query.get('search') ?? '');

	if (searching) {
		conditions.push('h.package_id IS NOT NULL');
	}

	const levels = (query.get('levels') ?? '').split(',').map(v => parseInt(v, 10)).filter(Number.isFinite);

	// Выбранная сложность — это и есть ответ на вопрос «показывать ли без оценки»: нет.
	// Раньше галочка «показывать паки без оценки» жила своей жизнью и, будучи включённой
	// по умолчанию, подмешивала неоценённые паки к любому выбранному уровню.
	if (levels.length > 0) {
		const placeholders = levels.map(() => '?').join(',');
		conditions.push(`s.level IN (${placeholders})`);
		params.push(...levels);
	} else if (query.get('unrated') !== '1') {
		conditions.push('s.level IS NOT NULL');
	}

	// Тем можно выбрать сразу несколько: пак подходит, если у него есть хотя бы одна из них
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
				// а по доле: аниме-пак с опенингами должен попадать и сюда тоже. Условие про ярлык
				// отсеивает коротышей, которым доли не считаются (см. topicMinQuestions).
				parts.push(`(p.primary_topic IS NOT NULL AND ${shareOf(MUSIC_KEY)} >= ?)`);
				params.push(config.musicThreshold);
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
	// на него обязано показать паки по обоим (см. subject.js).
	const subject = (query.get('subject') ?? '').trim();

	if (subject) {
		const names = subjectMatches(subjectGroups(), subject);
		conditions.push(`p.franchise_top IN (${names.map(() => '?').join(',')}) AND p.franchise_top_share >= ?`);
		params.push(...names, config.subjectPackShare);
	}

	if (query.get('hidePlayed') === '1') {
		conditions.push('pl.package_id IS NULL');
	}

	if (query.get('onlyPlayed') === '1') {
		conditions.push('pl.package_id IS NOT NULL');
	}

	// Запланированное отбирается тут же, рядом с сыгранным: «что мы собирались
	// сыграть» — тот же вопрос к своим отметкам, только про будущее
	if (query.get('onlyPlanned') === '1') {
		conditions.push('pn.package_id IS NOT NULL');
	}

	// Отсечка по времени появления в обсуждении живёт здесь, а не в сортировке:
	// иначе счётчик «найдено» считал бы паки, которых в выдаче нет.
	const period = periodOf(query.get('sort') ?? 'added');

	if (period) {
		conditions.push('p.vk_ts IS NOT NULL AND p.vk_ts >= ?');
		params.push(periodStart(period));
	}

	return { where: conditions.join(' AND '), params, searching };
}

// Оценки приходят свёрнутыми по ключу пака: все копии одного файла делят их
// между собой — иначе порог показа не взял бы ни один пак, выложенный дважды.
const BASE_FROM = `
	FROM packages p
	LEFT JOIN stats s ON s.package_id = p.id
	LEFT JOIN played pl ON pl.package_id = p.id
	LEFT JOIN planned pn ON pn.package_id = p.id
	LEFT JOIN temp.search_hits h ON h.package_id = p.id
	LEFT JOIN (
		SELECT pack_key, COUNT(*) AS rating_count, AVG(score) AS rating_average
		FROM ratings GROUP BY pack_key
	) r ON r.pack_key = ${PACK_KEY_SQL}
`;

/** Своя оценка пака. Отдельным подзапросом: без входа спрашивать не о чем. */
const MY_SCORE = `(SELECT score FROM ratings WHERE pack_key = ${PACK_KEY_SQL} AND user_id = ?) AS my_score`;

/**
 * Сколько паков каждой сложности осталось при нынешних фильтрах. Числа стоят
 * в колонке слева, и общие по базе там врали: выбрав «Аниме», человек видел
 * «Лёгких — 812», а в выдаче их оказывалось четырнадцать.
 *
 * Сама сложность из подсчёта выброшена нарочно: иначе у выбранного уровня
 * стояло бы его же число, а у остальных — нули, и переключиться было бы не на что.
 * Галочка «показывать паки без оценки» тоже: здесь считаются только те, у кого
 * оценка есть.
 */
function countLevels(query, userId) {
	const asked = new URLSearchParams(query);
	asked.delete('levels');
	asked.set('unrated', '1');

	const { where, params } = buildWhere(asked, userId);

	const rows = db.prepare(`
		SELECT s.level AS level, COUNT(*) AS c
		${BASE_FROM}
		WHERE ${where} AND s.level IS NOT NULL
		GROUP BY s.level
	`).all(...params);

	const counts = {};

	for (const row of rows) {
		counts[row.level] = row.c;
	}

	return counts;
}

function listPackages(query, userId) {
	const { where, params, searching } = buildWhere(query, userId);

	const sortKey = query.get('sort') ?? 'added';
	const direction = query.get('dir') === 'asc' ? 'ASC' : 'DESC';

	// Для сложности «по убыванию» естественно читается как «от самых сложных»,
	// поэтому направление переворачивается, а паки без оценки всегда уходят в конец.
	let orderBy;

	if (periodOf(sortKey)) {
		orderBy = `${SORTS.games} ${direction}`;
	} else if (sortKey === 'added') {
		// Паки с неразобранным временем сообщения уходят в конец при любом
		// направлении: у «сначала новые» им места нет ни с той, ни с другой стороны.
		//
		// Написано это через NULLS LAST, а не отдельным первым условием
		// «p.vk_ts IS NULL», хотя порядок получается тот же самый. Разница
		// в цене: выражение перед сортировкой указателю не соответствует,
		// и база вынуждена была сложить в память ВСЕ подходящие паки, отсортировать
		// их целиком и только потом взять двадцать четыре. На пятистах паках это
		// не замечалось, на пятнадцати тысячах главная страница стоила 0,7 секунды
		// против пяти миллисекунд теперь: с NULLS LAST порядок берётся прямо
		// из указателя (status, vk_ts), и дальше первых двух десятков строк
		// база не читает вовсе.
		orderBy = `${SORTS.added} ${direction} NULLS LAST`;
	} else if (sortKey === 'relevance') {
		// Порядок задаёт сам поиск (см. ниже), а внутри одной ступени совпадения
		// паки идут как обычно — сначала новые. Без поиска сортировать не по чему:
		// «по совпадению с запросом» без запроса — это и есть выдача как есть.
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
	// (см. rankEntry в src/fuzzy.js). Любая другая сортировка ступень не смотрит —
	// выбрав «по числу вопросов», человек просит именно его.
	if (searching) {
		orderBy = sortKey === 'relevance' ? `h.hit_rank, h.tier, ${orderBy}` : `h.tier, ${orderBy}`;
	}

	const pageSize = Math.min(Math.max(parseInt(query.get('pageSize') ?? '24', 10) || 24, 1), 100);
	const page = Math.max(parseInt(query.get('page') ?? '1', 10) || 1, 1);
	const offset = (page - 1) * pageSize;

	const total = db.prepare(`SELECT COUNT(*) AS c ${BASE_FROM} WHERE ${where}`).get(...params).c;

	// Своя оценка стоит в списке полей, то есть её параметр идёт ПЕРЕД теми,
	// что собрал buildWhere: порядок здесь и есть порядок подстановки.
	const rows = db.prepare(`
		SELECT p.*, s.started_games, s.completed_games, s.shown, s.right_percent, s.take_percent, s.level,
			s.found AS stats_found, CASE WHEN pl.package_id IS NULL THEN 0 ELSE 1 END AS played,
			CASE WHEN pn.package_id IS NULL THEN 0 ELSE 1 END AS planned,
			r.rating_count, r.rating_average, ${MY_SCORE}
		${BASE_FROM}
		WHERE ${where}
		ORDER BY ${orderBy}, p.id DESC
		LIMIT ? OFFSET ?
	`).all(userId ?? null, ...params, pageSize, offset);

	// Числа сложностей считаются здесь же, а не отдельным запросом с сайта:
	// они меняются ровно тогда же, когда меняется выдача, и вторая ходка
	// на сервер ради них означала бы, что колонка слева на миг врёт
	return { total, page, pageSize, levels: countLevels(query, userId), packages: rows.map(toPackage) };
}

/**
 * Один пак по номеру строки — для его отдельной страницы (/pack/…).
 *
 * Поля те же самые, что и в выдаче: страница пака рисуется той же карточкой,
 * и недостающее поле обернулось бы там пустым местом посреди готовой вёрстки.
 * Чёрный список здесь не применяется нарочно: спрятанный пак пропадает из выдачи,
 * но по прямой ссылке открываться должен — иначе она выглядит битой.
 */
function getPackage(id, userId) {
	const row = db.prepare(`
		SELECT p.*, s.started_games, s.completed_games, s.shown, s.right_percent, s.take_percent, s.level,
			s.found AS stats_found, CASE WHEN pl.package_id IS NULL THEN 0 ELSE 1 END AS played,
			CASE WHEN pn.package_id IS NULL THEN 0 ELSE 1 END AS planned,
			r.rating_count, r.rating_average, ${MY_SCORE}
		${BASE_FROM}
		WHERE p.id = ? AND p.status = 'ok'
	`).get(userId ?? null, id);

	return row ? toPackage(row) : null;
}

/** Все паки для карты сайта: только то, из чего складывается адрес и дата. */
const sitemapQuery = db.prepare(`
	SELECT id, name, file_name, vk_ts FROM packages WHERE status = 'ok' ORDER BY id
`);

function getFacets() {
	// Теги в паках пишут кто как: «Аниме», «аниме», «anime». Считаем их одним и тем же
	// и показываем то написание, которое встречается чаще.
	const groups = new Map();
	const rows = db.prepare(`SELECT tags FROM packages WHERE status = 'ok'`).all();

	for (const row of rows) {
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

	const levels = db.prepare('SELECT level, COUNT(*) AS c FROM stats WHERE level IS NOT NULL GROUP BY level').all();
	const levelCounts = {};

	for (const row of levels) {
		levelCounts[row.level] = row.c;
	}

	const topicCounts = {};

	for (const row of db.prepare(`SELECT primary_topic, COUNT(*) AS c FROM packages WHERE status = 'ok' AND primary_topic IS NOT NULL GROUP BY primary_topic`).all()) {
		topicCounts[row.primary_topic] = row.c;
	}

	topicCounts.unknown = db.prepare(`SELECT COUNT(*) AS c FROM packages WHERE status = 'ok' AND primary_topic IS NULL`).get().c;

	// Музыкальных считаем по доле, а не по ярлыку: у аниме-пака с опенингами
	// ярлык будет «Аниме-пак», но в музыкальные он попасть должен.
	topicCounts[MUSIC_KEY] = db.prepare(`
		SELECT COUNT(*) AS c FROM packages p
		WHERE p.status = 'ok' AND p.primary_topic IS NOT NULL AND ${shareOf(MUSIC_KEY)} >= ?
	`).get(config.musicThreshold).c;

	// Дополнительные типы паков: те, что целиком про один предмет, — «пак по
	// Вархаммеру», «пак по футболу». Пяти основных тематик для них не хватает:
	// пак про футбол по ним «солянка», а пак по Вархаммеру — просто «игропак».
	//
	// Полного списка франшиз здесь по-прежнему нет: обходить json_each по всей
	// таблице ради поля, которое никто не читает, — самый дорогой запрос из всех,
	// что тут были. Здесь читается готовая колонка с самым частым предметом,
	// и обе колонки отбора лежат в указателе (ix_packages_ok_subject).
	//
	// Отсечка по числу стоит после сведения, а не в самом запросе: сведённая
	// «Дота» — это сумма «Доты» и «Доты 2», и обрезать список до сведения значило
	// бы иногда отрезать половину типа.
	const subjects = subjectGroups().slice(0, config.subjectLimit);

	// Языки паков. Считаются по тому, что записано в самом файле; там же, где
	// язык не указан, стоит unknown — таких паков в базе заметная часть,
	// и прятать их из фильтра нельзя.
	const languages = db.prepare(`
		SELECT ${LANG_SQL} AS lang, COUNT(*) AS c
		FROM packages p WHERE p.status = 'ok'
		GROUP BY lang ORDER BY c DESC
	`).all();

	return {
		tags: [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
		languages: languages.map(row => ({
			key: row.lang,
			name: LANGUAGE_NAMES[row.lang] ?? row.lang.toUpperCase(),
			count: row.c,
		})),
		specialNames: SPECIAL_NAMES,
		levels: levelCounts,
		levelNames: LEVELS,
		topics: topicCounts,
		topicNames: TOPICS,
		topicThreshold: config.topicThreshold,
		musicThreshold: config.musicThreshold,
		total: db.prepare(`SELECT COUNT(*) AS c FROM packages WHERE status = 'ok'`).get().c,
		rated: db.prepare('SELECT COUNT(*) AS c FROM stats WHERE level IS NOT NULL').get().c,
		// Копии одного пака считаем за один сыгранный
		played: db.prepare(`
			SELECT COUNT(DISTINCT ${PACK_KEY_SQL}) AS c
			FROM played pl JOIN packages p ON p.id = pl.package_id
		`).get().c,
		// Отложенное на будущий вечер — тем же счётом
		planned: db.prepare(`
			SELECT COUNT(DISTINCT ${PACK_KEY_SQL}) AS c
			FROM planned pn JOIN packages p ON p.id = pn.package_id
		`).get().c,
		minGames: config.minGamesForDifficulty,
		// Второй порог оценки: одних игр мало, по паку ещё должно быть показано
		// столько вопросов. Без него сайт обещал оценку, которая не появлялась.
		minShown: config.minShownForDifficulty,
		thresholds: config.difficultyThresholds,
		// Доля правильных ответов, ниже которой пак считается ступенью сложнее
		hardRight: config.hardRightPercent,
		franchiseMinThemes: config.franchiseMinThemes,
		franchiseDominantShare: config.franchiseDominantShare,
		// Дополнительные типы паков и порог, с которого пак считается паком про одно.
		// key — то же название латиницей и без номера части: по нему в колонке
		// фильтров находится «Дота», когда набирают «dota»
		subjects: subjects.map(group => ({ name: group.name, key: group.key, count: group.count })),
		subjectPackShare: config.subjectPackShare,
		// Пак про одну вселенную: с этой доли ярлык называет её прямо — «Кинопак (Гарри Поттер)»
		universePackShare: config.universePackShare,
		// Виды «прочего» и порог, с которого их стоит называть вслух: «Прочее: стримеры, история»
		otherKindNames: OTHER_KINDS,
		otherKindShare: config.otherKindShare,
		// Жанры внутри тематики и порог, с которого жанр стоит называть: из них
		// собирается третья полоска карточки — «какой жанр музыки»
		genreNames: GENRES,
		genreShare: config.genreShare,
		// На хостинге собирать базу нечем: сайт не показывает ни страницы обновления, ни ссылки на неё
		readOnly: config.readOnly,
		playerUri: config.playerUri,
		// Есть ли вход вообще: без ключей приложения Discord сайт работает как раньше,
		// и показывать кнопку, которая никуда не ведёт, незачем
		hasDiscord: hasDiscord(),
		// Можно ли прятать паки без входа. На своей машине — можно: список тогда
		// принадлежит установке, как и отметки «сыграно»
		localBlacklist: config.localBlacklist,
		// Со скольких оценок показывается средний балл
		minRatings: config.minRatingsForScore,
		// Паки, у которых не разобралось время сообщения ВК, в подборки «за период»
		// не попадают — сайт пишет, скольких это касается, чтобы пропажа не выглядела ошибкой.
		datedPackages: db.prepare(`SELECT COUNT(*) AS c FROM packages WHERE status = 'ok' AND vk_ts IS NOT NULL`).get().c,
	};
}

/**
 * Топ авторов по числу игр. Считается по статистике SIGame: сколько раз запускали
 * паки этого автора — всего, а не «сколько раз запускали за период». Окно подсчёта
 * игр сервис статистики отдавать не умеет вовсе, поэтому период здесь означает
 * ровно то же, что и в подборках «популярное за месяц»: берутся паки, выложенные
 * в обсуждение за этот срок, а игры у них считаются за всё время.
 *
 * Копии одного пака сводятся к одной строке: иначе автор, чей пак выложили дважды,
 * получал бы двойной счёт игр.
 */
const AUTHOR_PERIODS = { month: 30, half: 182, year: 365, all: null };

function getTopAuthors(query) {
	const asked = query.get('period') ?? 'all';
	const periodKey = Object.hasOwn(AUTHOR_PERIODS, asked) ? asked : 'all';
	const days = AUTHOR_PERIODS[periodKey];

	const params = [];
	let filter = `p.status = 'ok'`;

	if (days) {
		filter += ' AND p.vk_ts IS NOT NULL AND p.vk_ts >= ?';
		params.push(periodStart(days));
	}

	const rows = db.prepare(`
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
	`).all(...params);

	return {
		period: periodKey,
		// Все, кто вообще подписал хоть один пак. Раньше список обрывался на двухстах,
		// и человек, чей единственный пак играли полсотни раз, в нём просто
		// не существовал — а страница называется «топ авторов», и вопрос «а я тут
		// где» ей задают чаще всего.
		total: rows.length,
		authors: rows.map((row, index) => ({
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

const markPlayed = db.prepare('INSERT OR REPLACE INTO played (package_id, marked_at) VALUES (?, ?)');
const unmarkPlayed = db.prepare('DELETE FROM played WHERE package_id = ?');

/**
 * Один и тот же пак нередко выложен в обсуждение не раз. Отметка ставится
 * сразу на все его копии — по идентификатору из самого файла и названию,
 * то есть по тому же правилу, что и общий ключ пака (см. packKey): одним
 * идентификатором автор нередко метит всю свою серию паков, и по нему одному
 * отметка «сыграно» зажигалась сразу на нескольких разных паках.
 */
const twinPackages = db.prepare(`
	SELECT id FROM packages
	WHERE id = ?1
		OR (COALESCE(TRIM(pack_id), '') <> ''
			AND TRIM(pack_id) = (SELECT TRIM(pack_id) FROM packages WHERE id = ?1)
			AND TRIM(COALESCE(name, '')) = (SELECT TRIM(COALESCE(name, '')) FROM packages WHERE id = ?1))
`);

/**
 * Отмечен ли пак сыгранным. Спрашивается по общему ключу всех копий: отметка
 * ставится сразу на все, и оценка тоже принадлежит паку, а не строке в базе.
 */
const playedPackQuery = db.prepare(`
	SELECT 1 FROM played pl JOIN packages p ON p.id = pl.package_id
	WHERE ${PACK_KEY_SQL} = ? LIMIT 1
`);

function isPlayedPack(key) {
	return key ? playedPackQuery.get(key) !== undefined : false;
}

function setPlayed(id, played) {
	const ids = twinPackages.all(id).map(row => row.id);

	for (const packageId of ids) {
		if (played) {
			markPlayed.run(packageId, Date.now());
			// Сыграли — значит, «собираемся сыграть» кончилось само собой. Оставлять
			// пак в запланированном после отметки значило бы требовать двух нажатий
			// там, где произошло одно событие; вернуть его в список можно тем же
			// «Запланировать», если за него сядут ещё раз.
			unmarkPlanned.run(packageId);
		} else {
			unmarkPlayed.run(packageId);
		}
	}

	return ids.length;
}

const markPlanned = db.prepare('INSERT OR REPLACE INTO planned (package_id, marked_at) VALUES (?, ?)');
const unmarkPlanned = db.prepare('DELETE FROM planned WHERE package_id = ?');

/**
 * Отобрать пак на будущий вечер — или передумать. Устроено ровно как отметка
 * «сыграно»: ставится сразу на все копии пака, потому что копия — это тот же
 * самый файл, выложенный в обсуждение дважды.
 */
function setPlanned(id, planned) {
	const ids = twinPackages.all(id).map(row => row.id);

	for (const packageId of ids) {
		if (planned) {
			markPlanned.run(packageId, Date.now());
		} else {
			unmarkPlanned.run(packageId);
		}
	}

	return ids.length;
}

/**
 * То же по общему ключу: этим переезжают отметки, сделанные до входа, — и этим
 * же приезжает список из файла.
 *
 * `times` — необязательная карта «ключ → когда»: у отметок из файла своё время,
 * и ставить им сегодняшнее значило бы стереть, когда в пак на самом деле играли.
 */
function setPlannedKeys(keys, planned, times = {}) {
	let affected = 0;

	for (const key of new Set((keys ?? []).map(value => String(value ?? '').trim()).filter(Boolean))) {
		for (const row of packagesByKey.all(key)) {
			if (planned) {
				markPlanned.run(row.id, times[key] ?? Date.now());
			} else {
				unmarkPlanned.run(row.id);
			}

			affected++;
		}
	}

	return affected;
}

/** Строки паков по общему ключу: у копий одного файла ключ один на всех. */
const packagesByKey = db.prepare(`SELECT p.id FROM packages p WHERE ${PACK_KEY_SQL} = ?`);

/**
 * Отметить сыгранными сразу список паков, названных общим ключом. Нужно переносу
 * отметок, сделанных до входа: без учётной записи они лежат в самом браузере
 * (см. web/app.js), а номера строк для этого не годятся — они меняются при
 * каждой пересборке базы, ключ же считается из самого файла.
 */
function setPlayedKeys(keys, played, times = {}) {
	let affected = 0;

	for (const key of new Set((keys ?? []).map(value => String(value ?? '').trim()).filter(Boolean))) {
		for (const row of packagesByKey.all(key)) {
			if (played) {
				markPlayed.run(row.id, times[key] ?? Date.now());
			} else {
				unmarkPlayed.run(row.id);
			}

			affected++;
		}
	}

	return affected;
}

// ————— список паков файлом —————

/**
 * Что из файла нашлось в базе. Записи там названы по-человечески — названием
 * и авторами (см. src/packlist.js), — и превратить их в ключи паков может
 * только сервер: он один знает, что в базе лежит.
 *
 * Спрашивается всё одним запросом на две сотни названий, а не запросом
 * на запись: список приносят целиком, и двести походов в базу подряд —
 * это ровно та работа, которую SQL умеет делать за один.
 */
const packsByNames = names => db.prepare(`
	SELECT p.id, p.name, p.authors, p.pack_id
	FROM packages p
	WHERE p.status = 'ok' AND ${NAME_KEY_SQL} IN (${names.map(() => '?').join(',')})
`).all(...names);

function matchList(data) {
	const entries = readPackList(data);
	const names = askedNames(entries);
	const rows = chunk(names).flatMap(part => (part.length > 0 ? packsByNames(part) : []));

	return { total: entries.length, ...matchPackList(entries, rows) };
}

/**
 * Обратный ход: по ключам паков — их названия и авторы. Нужен вывозу списка
 * оттуда, где отметки лежат в самом браузере: там от пака известен один ключ,
 * а в файл идёт то, что человек прочитает.
 */
const packsByKeys = keys => db.prepare(`
	SELECT p.name, p.authors, MIN(p.id) AS id, ${PACK_KEY_SQL} AS pack_key
	FROM packages p
	WHERE p.status = 'ok' AND ${PACK_KEY_SQL} IN (${keys.map(() => '?').join(',')})
	GROUP BY pack_key
`).all(...keys);

function namePacks(keys) {
	const wanted = [...new Set((keys ?? []).map(value => String(value ?? '')).filter(Boolean))];
	const rows = chunk(wanted).flatMap(part => (part.length > 0 ? packsByKeys(part) : []));

	return rows.map(row => ({
		key: row.pack_key,
		name: row.name,
		authors: jsonOrDefault(row.authors, []),
	}));
}

/**
 * Профиль: всё, что известно про сыгранное. Копии одного пака считаются за один —
 * отметка ставится сразу на все, и в библиотеке они иначе двоились бы.
 *
 * Отметки «сыграно» пока общие на всю установку: у них, в отличие от оценок
 * и чёрного списка, хозяина нет. На хостинге это заметно — отмеченное одним
 * видят все, — и следующим шагом стоит привязать их к тому же user_id.
 */
function getProfile(userId) {
	// MIN(marked_at) здесь не только выбирает время, но и решает, какую из копий
	// пака показать: SQLite берёт остальные поля из той же строки, на которой
	// сошёлся минимум. Копии сливаются по идентификатору из самого файла — так же,
	// как их сливает отметка «сыграно» (см. twinPackages).
	const rows = db.prepare(`
		SELECT p.*, s.started_games, s.completed_games, s.shown, s.right_percent, s.take_percent, s.level,
			s.found AS stats_found, 1 AS played, MIN(pl.marked_at) AS marked_at,
			r.rating_count, r.rating_average, ${MY_SCORE}
		FROM played pl
		JOIN packages p ON p.id = pl.package_id
		LEFT JOIN stats s ON s.package_id = p.id
		LEFT JOIN (
			SELECT pack_key, COUNT(*) AS rating_count, AVG(score) AS rating_average
			FROM ratings GROUP BY pack_key
		) r ON r.pack_key = ${PACK_KEY_SQL}
		WHERE p.status = 'ok'
		GROUP BY ${PACK_KEY_SQL}
		ORDER BY marked_at DESC
	`).all(userId ?? null);

	const packages = rows.map(row => ({ ...toPackage(row), markedAt: row.marked_at }));

	const levels = {};
	const topics = {};
	const authors = new Map();
	let questions = 0;

	for (const pack of packages) {
		questions += pack.questionCount ?? 0;

		const level = pack.stats?.level;

		if (level) {
			levels[level] = (levels[level] ?? 0) + 1;
		}

		const topic = pack.primaryTopic ?? 'unknown';
		topics[topic] = (topics[topic] ?? 0) + 1;

		for (const author of pack.authors) {
			authors.set(author, (authors.get(author) ?? 0) + 1);
		}
	}

	// Запланированное. Тот же запрос, только по другой таблице и в обратную
	// сторону по смыслу: сыгранное — что уже было, запланированное — что впереди.
	// Сортировка тоже своя: сначала недавно отложенное — то, о чём человек
	// думал последним.
	const plannedRows = db.prepare(`
		SELECT p.*, s.started_games, s.completed_games, s.shown, s.right_percent, s.take_percent, s.level,
			s.found AS stats_found, 1 AS planned,
			CASE WHEN pl.package_id IS NULL THEN 0 ELSE 1 END AS played, MIN(pn.marked_at) AS marked_at,
			r.rating_count, r.rating_average, ${MY_SCORE}
		FROM planned pn
		JOIN packages p ON p.id = pn.package_id
		LEFT JOIN stats s ON s.package_id = p.id
		LEFT JOIN played pl ON pl.package_id = p.id
		LEFT JOIN (
			SELECT pack_key, COUNT(*) AS rating_count, AVG(score) AS rating_average
			FROM ratings GROUP BY pack_key
		) r ON r.pack_key = ${PACK_KEY_SQL}
		WHERE p.status = 'ok'
		GROUP BY ${PACK_KEY_SQL}
		ORDER BY marked_at DESC
	`).all(userId ?? null);

	return {
		total: packages.length,
		questions,
		levels,
		topics,
		planned: plannedRows.map(row => ({ ...toPackage(row), markedAt: row.marked_at })),
		// Личный чёрный список: показать его больше негде, а снимать оттуда
		// как-то надо — на карточках спрятанного по определению не видно
		blacklist: userId ? listBlacklist(userId) : [],
		// Авторы, чьих паков сыграно больше одного: «любимые» из одного пака не выходят
		favouriteAuthors: [...authors.entries()]
			.filter(([, count]) => count > 1)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 12)
			.map(([name, count]) => ({ name, count })),
		packages,
	};
}

function readBody(request) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		request.on('data', chunk => chunks.push(chunk));
		request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		request.on('error', reject);
	});
}

// ————— сжатие ответов —————
//
// Cloudflare сжимает всё, что отдаёт, сам; домашний сервер не сжимал ничего,
// и разница выходила не косметическая. Страница библиотеки — это ответ выдачи
// на две дюжины паков, список тем для фильтров, стили и три скрипта: полтора
// мегабайта текста, каждый байт которого ехал как есть. Текст этот сжимается
// раз в пять-семь (много повторов: одни и те же ключи JSON, русские названия
// тем), и по домашней сети разница заметна, а по Wi-Fi с телефона — тем более.
//
// Сжимается только текст. Обложки уже сжаты своим форматом, и второй проход
// по ним — чистая трата времени процессора: AVIF от gzip не худеет.

/** Меньше этого сжимать не за чем: заголовок ответа и тот длиннее. */
const COMPRESS_MIN = 1024;

const COMPRESSIBLE = /^(text\/|application\/(json|xml|javascript)|image\/svg)/;

/**
 * Brotli жмёт лучше gzip, но его настройка по умолчанию (11) считает секундами:
 * она рассчитана на файл, который сожмут один раз при сборке, а не на ответ,
 * который собирают заново каждому пришедшему. Четвёрка — обычный выбор для
 * ответов на лету: по весу это тот же gzip или чуть лучше, по времени — миллисекунды.
 */
const BROTLI = {
	params: {
		[zlib.constants.BROTLI_PARAM_QUALITY]: 4,
		[zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
	},
};

function pickEncoding(request) {
	const accepted = String(request?.headers?.['accept-encoding'] ?? '');

	if (/\bbr\b/.test(accepted)) {
		return 'br';
	}

	return /\bgzip\b/.test(accepted) ? 'gzip' : null;
}

/**
 * Ответ телом-буфером, сжатый, если пришедший это умеет и если сжимать есть что.
 *
 * Запрос берётся из самого ответа (`response.req`): звать sendJson приходится
 * из трёх десятков мест, и таскать через все из них ещё один довод ради одного
 * заголовка не за чем.
 */
function sendBody(response, status, headers, body, request = response.req) {
	const encoding = COMPRESSIBLE.test(headers['Content-Type'] ?? '') && body.length >= COMPRESS_MIN
		? pickEncoding(request)
		: null;

	if (!encoding) {
		response.writeHead(status, { ...headers, 'Content-Length': body.length });
		response.end(body);
		return;
	}

	const pack = (input, done) => (encoding === 'br'
		? zlib.brotliCompress(input, BROTLI, done)
		: zlib.gzip(input, done));

	pack(body, (error, packed) => {
		// Сжать не вышло — отдаём как есть: ответ важнее его веса
		if (error) {
			response.writeHead(status, { ...headers, 'Content-Length': body.length });
			response.end(body);
			return;
		}

		response.writeHead(status, {
			...headers,
			'Content-Encoding': encoding,
			'Content-Length': packed.length,
			// Без этого промежуточный кэш отдал бы сжатый ответ тому, кто сжатия
			// не просил, — и наоборот
			Vary: headers.Vary ? `${headers.Vary}, Accept-Encoding` : 'Accept-Encoding',
		});

		response.end(packed);
	});
}

function sendJson(response, data, status = 200) {
	sendBody(response, status, { 'Content-Type': 'application/json; charset=utf-8' }, Buffer.from(JSON.stringify(data)));
}

/**
 * Отдаёт файл с диска.
 *
 * @param {boolean} cacheable вечный ли у файла кэш. Обложки — самое тяжёлое,
 *   что отдаёт сайт: их тысячи, в среднем по 180 КБ, и на страницу их разом
 *   приходит два десятка. Файл обложки никогда не меняется (имя привязано
 *   к номеру пака, а новая обложка получает новое имя), поэтому кэш вечный
 *   и безусловный. Вёрстке и скриптам так нельзя — их правят, — но и им
 *   спрашивать про каждый файл заново незачем: ниже у всего есть отпечаток,
 *   и в ответ на «не менялось ли» приходит пустой 304 вместо ста килобайт.
 */
function sendFile(response, filePath, request = null, cacheable = false) {
	fs.readFile(filePath, (error, data) => {
		if (error) {
			response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Не найдено');
			return;
		}

		const headers = { 'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream' };
		const stat = fs.statSync(filePath, { throwIfNoEntry: false });

		// Отпечаток считается по размеру и времени правки: содержимое для этого
		// читать не надо, а меняются они вместе с ним.
		//
		// Способ сжатия входит в отпечаток нарочно: у сжатого и несжатого ответа
		// тела разные, и один и тот же отпечаток на оба означал бы, что кэш
		// однажды отдаст gzip тому, кто его не понимает.
		const encoding = pickEncoding(request);
		const tag = stat ? `"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}${encoding ? `-${encoding}` : ''}"` : null;

		headers['Cache-Control'] = cacheable ? 'public, max-age=31536000, immutable' : 'no-cache';

		if (tag) {
			headers.ETag = tag;

			// Браузер уже спрашивал про этот файл — не гоним его второй раз
			if (request?.headers['if-none-match'] === tag) {
				response.writeHead(304, headers);
				response.end();
				return;
			}
		}

		sendBody(response, 200, headers, data, request);
	});
}

function sendStatic(response, urlPath, request = null) {
	// Логотипы лежат не в web, а рядом с базой
	const isLogo = urlPath.startsWith('/logos/');
	const root = isLogo ? config.logosPath : config.webPath;
	const relative = urlPath === '/' ? 'index.html' : urlPath.replace(isLogo ? /^\/logos\/+/ : /^\/+/, '');
	const filePath = path.join(root, relative);

	if (!filePath.startsWith(root)) {
		response.writeHead(403).end('Forbidden');
		return;
	}

	sendFile(response, filePath, request, isLogo);
}

const server = http.createServer(async (request, response) => {
	const url = new URL(request.url, `http://localhost:${config.port}`);

	try {
		// Кто спрашивает. Без входа это просто null, и сайт работает как раньше:
		// оценки видны, но не ставятся, чёрный список не применяется.
		const user = hasDiscord() ? currentUser(request) : null;

		// ————— вход через Discord —————
		//
		// Вход и всё, что за ним, живут в стороне от config.readOnly: тот запрещает
		// собирать базу (дёргать Gemini и ВК с чужого адреса), а оценки и чёрный
		// список — единственное, ради чего сайт на хостинге вообще нужен людям.

		if (url.pathname === '/auth/discord') {
			if (!hasDiscord()) {
				response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Вход через Discord не настроен');
				return;
			}

			startLogin(response);
			return;
		}

		if (url.pathname === '/auth/discord/callback') {
			if (!hasDiscord()) {
				response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Вход через Discord не настроен');
				return;
			}

			await finishLogin(request, response, url);
			return;
		}

		if (url.pathname === '/auth/logout' && request.method === 'POST') {
			logout(request, response);
			return;
		}

		if (url.pathname === '/api/me') {
			sendJson(response, { user, hasDiscord: hasDiscord() });
			return;
		}

		if (url.pathname === '/api/rate' && request.method === 'POST') {
			if (!user) {
				sendJson(response, { error: 'Оценивать паки можно, только войдя через Discord' }, 401);
				return;
			}

			const { packKey: key, score } = JSON.parse(await readBody(request));

			// Оценка ставится только тому, во что играли. Иначе она превращается
			// в оценку обложки и описания: пак с красивым названием набирал бы
			// баллы, ни разу не побывав на столе.
			if (!isPlayedPack(String(key ?? ''))) {
				sendJson(response, { error: 'Оценить пак можно после того, как он отмечен сыгранным' }, 400);
				return;
			}

			try {
				sendJson(response, rate(String(key ?? ''), user.id, score));
			} catch (error) {
				sendJson(response, { error: error.message }, 400);
			}

			return;
		}

		if (url.pathname === '/api/blacklist' && request.method === 'POST') {
			const owner = blacklistOwner(user);

			if (!owner) {
				sendJson(response, { error: 'Чёрный список появляется после входа через Discord' }, 401);
				return;
			}

			const { kind, value, label, blacklisted } = JSON.parse(await readBody(request));

			try {
				sendJson(response, setBlacklisted(owner, kind, value, label, blacklisted));
			} catch (error) {
				sendJson(response, { error: error.message }, 400);
			}

			return;
		}

		if (url.pathname === '/api/blacklist') {
			const owner = blacklistOwner(user);
			sendJson(response, { items: owner ? listBlacklist(owner) : [] });
			return;
		}

		if (url.pathname === '/api/packages') {
			sendJson(response, listPackages(url.searchParams, blacklistOwner(user)));
			return;
		}

		// Один пак: этим живёт его отдельная страница
		if (url.pathname === '/api/package') {
			const pack = getPackage(parseInt(url.searchParams.get('id') ?? '', 10), blacklistOwner(user));

			if (!pack) {
				sendJson(response, { error: 'Такого пака нет' }, 404);
				return;
			}

			sendJson(response, { package: pack });
			return;
		}

		if (url.pathname === '/api/facets') {
			sendJson(response, { ...getFacets(), user });
			return;
		}

		if (url.pathname === '/api/authors') {
			sendJson(response, getTopAuthors(url.searchParams));
			return;
		}

		if (url.pathname === '/api/profile') {
			sendJson(response, getProfile(blacklistOwner(user)));
			return;
		}

		if (url.pathname === '/api/played' && request.method === 'POST') {
			const { id, packKeys, played, markedAt } = JSON.parse(await readBody(request));

			// Списком ключей приезжают отметки, сделанные до входа: на хостинге
			// они до этого мига лежали в самом браузере (см. web/app.js). Дома
			// такого не бывает — отметки тут и без входа принадлежат установке, —
			// но метод один на обе половины, и отвечать он должен одинаково.
			if (Array.isArray(packKeys)) {
				sendJson(response, { played: !!played, affected: setPlayedKeys(packKeys, played, markedAt) });
				return;
			}

			const affected = setPlayed(id, played);

			sendJson(response, { id, played: !!played, affected });
			return;
		}

		// Запланированное — отдельным методом, а не признаком у /api/played:
		// это две разные отметки, и снимать одну, ставя другую, сайт не должен
		// (см. таблицу planned). Отвечает он тем же, чем и сыгранное.
		if (url.pathname === '/api/planned' && request.method === 'POST') {
			const { id, packKeys, planned, markedAt } = JSON.parse(await readBody(request));

			if (Array.isArray(packKeys)) {
				sendJson(response, { planned: !!planned, affected: setPlannedKeys(packKeys, planned, markedAt) });
				return;
			}

			sendJson(response, { id, planned: !!planned, affected: setPlanned(id, planned) });
			return;
		}

		// Список паков файлом — только опознание, без единой отметки. Кто нашёлся,
		// тот и отмечается обычными /api/played и /api/planned, и правила у отметок
		// остаются прежними: дома они принадлежат установке, на хостинге —
		// вошедшему, а до входа живут в самом браузере (см. web/card.js).
		if (url.pathname === '/api/list' && request.method === 'POST') {
			const body = JSON.parse(await readBody(request));

			// Ключами спрашивают в другую сторону — как называются вот эти паки:
			// этим вывозится список из браузера, где имён у отметок нет
			if (Array.isArray(body.keys)) {
				sendJson(response, { packages: namePacks(body.keys) });
				return;
			}

			sendJson(response, matchList(body));
			return;
		}

		// На хостинге обновлять нечего: индексатора там нет, а Gemini и ВК с чужого
		// адреса дёргать не следует. Отвечаем отказом до разбора конкретного метода,
		// чтобы не осталось ни одной работающей лазейки.
		//
		// Никакого входа кнопка обновления при этом не требует: дома сайтом
		// пользуется хозяин, и спрашивать у него пропуск на своей же машине незачем.
		if (url.pathname.startsWith('/api/update/') && config.readOnly) {
			sendJson(response, { error: 'Обновление базы отключено: сайт работает только на чтение' }, 403);
			return;
		}

		if (url.pathname === '/api/update/state') {
			sendJson(response, updateState());
			return;
		}

		if (url.pathname === '/api/update/steps') {
			sendJson(response, { steps: UPDATE_STEPS, hasGemini: Boolean(config.geminiKey), hasVkToken: Boolean(config.vkToken) });
			return;
		}

		// Модели и расход запросов. Отдельным методом, а не вместе с шагами:
		// расход меняется прямо во время работы, и страница спрашивает его заново
		if (url.pathname === '/api/update/models') {
			sendJson(response, updateModels());
			return;
		}

		if (url.pathname === '/api/update/start' && request.method === 'POST') {
			try {
				sendJson(response, startUpdate(JSON.parse(await readBody(request))));
			} catch (error) {
				sendJson(response, { error: error.message }, 409);
			}

			return;
		}

		// Повторная отправка на сайт — после сорвавшейся. Обычное обновление зовёт
		// её само, последним своим шагом, и отдельного решения «выкладывать или нет»
		// больше нет (см. src/updater.js). Живёт среди методов обновления нарочно:
		// это такой же запуск программы с раздачей её вывода в лог, и на хостинге
		// его точно так же нет (см. отказ выше).
		if (url.pathname === '/api/update/deploy' && request.method === 'POST') {
			try {
				sendJson(response, startDeploy());
			} catch (error) {
				sendJson(response, { error: error.message }, 409);
			}

			return;
		}

		if (url.pathname === '/api/update/stop' && request.method === 'POST') {
			try {
				sendJson(response, stopUpdate());
			} catch (error) {
				sendJson(response, { error: error.message }, 409);
			}

			return;
		}

		if (url.pathname === '/api/update/events') {
			const unsubscribe = subscribe(response);
			request.on('close', unsubscribe);
			return;
		}

		if (url.pathname.startsWith('/api/')) {
			sendJson(response, { error: 'Неизвестный метод' }, 404);
			return;
		}

		// Уменьшенная обложка. Считается при первом обращении и потом лежит
		// готовой; если уменьшать нечем — отдаём оригинал, страница будет
		// тяжёлой, но целой.
		if (url.pathname.startsWith('/logos/thumb/')) {
			const file = path.basename(decodeURIComponent(url.pathname.slice('/logos/thumb/'.length)));
			const thumb = file ? await ensureThumb(file) : null;

			sendFile(response, thumb ?? path.join(config.logosPath, file), request, true);
			return;
		}

		// Значок лежит в корне проекта рядом с ярлыками, а не в папке сайта.
		//
		// Вечного кэша ему не даём нарочно, в отличие от обложек: имя у значка
		// одно и то же, а сам файл меняют — и с «immutable» браузер год не спросил
		// бы про него ни разу. Новый значок при этом не появлялся бы ни в закладке,
		// ни во вкладке, и выглядело бы это как «замена не сработала». Весит он
		// семь килобайт, и спросить про него лишний раз ничего не стоит.
		if (url.pathname === '/favicon.ico') {
			sendFile(response, config.iconPath, request);
			return;
		}

		// Страница обновления на хостинге не должна открываться и по прямой ссылке
		if (config.readOnly && /^\/update(\.html)?$/.test(url.pathname)) {
			response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Обновление базы отключено');
			return;
		}

		// Каким адресом сайт сам себя видит. Нужен поисковым мелочам — полной
		// ссылке на страницу пака, адресу карты сайта в robots.txt, каноническому
		// адресу в шапке.
		//
		// PUBLIC_URL важнее заголовка Host: за обратным прокси Host — это адрес
		// прокси, и в canonical уехал бы он, а поисковик по canonical решает,
		// какая страница настоящая. Дома PUBLIC_URL не задан, и остаётся Host.
		const origin = config.publicUrl || `http://${request.headers.host ?? `localhost:${config.port}`}`;

		// ————— отдельная страница пака —————
		//
		// Открывает её номер, стоящий сразу за /pack/, а название после него —
		// для человека и поисковой выдачи (см. src/slug.js). Вёрстка у всех паков
		// одна и та же, но заголовок вкладки и описание для поисковика в неё
		// подставляются здесь: рисует-то страницу скрипт, а читают их из самого
		// HTML, ещё до того, как хоть что-то отработает.
		const packId = packIdFromPath(url.pathname);

		if (packId !== null) {
			const pack = getPackage(packId, blacklistOwner(user));
			const html = fs.readFileSync(path.join(config.webPath, 'pack.html'), 'utf8');

			// Пака нет — страница всё равно та же самая: она сама скажет об этом
			// словами и позовёт обратно в библиотеку. Ответ при этом честный,
			// чтобы поисковик не держал у себя ссылку на пропавший пак.
			sendBody(response, pack ? 200 : 404, { 'Content-Type': MIME['.html'] },
				Buffer.from(pack ? injectPackMeta(html, pack, origin) : html), request);
			return;
		}

		// Карта сайта. Без неё отдельные страницы паков поисковику взять неоткуда:
		// постраничность выдачи сделана кнопками, и обойти её по ссылкам нельзя.
		if (url.pathname === '/sitemap.xml') {
			const rows = sitemapQuery.all().map(row => ({ id: row.id, name: row.name ?? row.file_name, vk_ts: row.vk_ts }));
			const body = buildSitemap(rows, origin);

			sendBody(response, 200, { 'Content-Type': 'application/xml; charset=utf-8' }, Buffer.from(body), request);
			return;
		}

		if (url.pathname === '/robots.txt') {
			sendBody(response, 200, { 'Content-Type': 'text/plain; charset=utf-8' }, Buffer.from(buildRobots(origin)), request);
			return;
		}

		const pages = {
			'/update': '/update.html',
			'/profile': '/profile.html',
			'/authors': '/authors.html',
			'/top': '/top.html',
		};

		sendStatic(response, pages[url.pathname] ?? url.pathname, request);
	} catch (error) {
		console.error(error);
		sendJson(response, { error: error.message }, 500);
	}
});

// Обновление базы открывает ту же страницу, что и обычный запуск сайта, поэтому
// второй запуск на занятом порту — не ошибка, а знак, что открывать нечего:
// сайт уже работает, и вкладка попадёт на него.
server.on('error', error => {
	if (error.code !== 'EADDRINUSE') {
		throw error;
	}

	console.log(`Сайт уже запущен на http://localhost:${config.port} — открывайте его.`);
	process.exit(0);
});

// На хостинге слушать только localhost нельзя: снаружи в такой сокет не постучаться
server.listen(config.port, process.env.HOST || undefined, () => {
	console.log(`Библиотека паков запущена: http://localhost:${config.port}`);

	if (config.readOnly) {
		console.log('Режим только для чтения: обновление базы отключено (FIREPACKS_READONLY=1).');
	} else {
		console.log(`Обновление базы: http://localhost:${config.port}/update`);
	}

	// Без входа нет ни оценок, ни чёрного списка, а сайт об этом молчал: кнопки
	// просто не появлялись, и понять, чего не хватает, было неоткуда.
	if (hasDiscord()) {
		console.log(`Вход через Discord включён. Адрес возврата: ${redirectUri()}`);
	} else {
		console.log(config.localBlacklist
			? 'Вход через Discord не настроен: оценок паков не будет. Чёрный список работает и без него,'
				+ ' но принадлежит этой установке, а не человеку.'
			: 'Вход через Discord не настроен: оценок паков и чёрного списка не будет.');
		console.log('  Заведите приложение на https://discord.com/developers/applications,');
		console.log(`  впишите в OAuth2 → Redirects адрес ${redirectUri()}`);
		console.log('  и положите ключи в data/discord-client-id.txt и data/discord-client-secret.txt');
	}

	// Список слов для поиска — заранее, пока сервер пустой. Собирается он полсекунды,
	// и без этой строчки они достаются тому, кто первым что-нибудь наберёт: набирают
	// по букве, и вся задержка приходится ровно на первую.
	setImmediate(warmSearch);
});
