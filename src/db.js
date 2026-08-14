import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { jsonOrDefault, buildTagsKey, buildAuthorKey, splitAuthors } from './keys.js';

// Ключи пака и чтение его полей лежат в keys.js: тот файл ничего не знает
// про node:sqlite, и его читает двойник сайта на Cloudflare Workers (см. cf/).
// Здесь они перевыпускаются наружу, чтобы остальной проект по-прежнему брал
// packKey и normalizeRounds отсюда.
export * from './keys.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 10000;

CREATE TABLE IF NOT EXISTS packages (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	source_key TEXT NOT NULL UNIQUE,
	url TEXT NOT NULL,
	file_name TEXT,
	name TEXT,
	authors TEXT NOT NULL DEFAULT '[]',
	authors_key TEXT,
	match_key TEXT,
	tags TEXT NOT NULL DEFAULT '[]',
	tags_key TEXT,
	author_difficulty INTEGER,
	language TEXT,
	pack_date TEXT,
	pack_id TEXT,
	size INTEGER,
	question_count INTEGER,
	round_count INTEGER,
	theme_count INTEGER,
	content_stat TEXT NOT NULL DEFAULT '{}',
	rounds TEXT NOT NULL DEFAULT '[]',
	vk_topic TEXT,
	vk_comment INTEGER,
	vk_author TEXT,
	vk_author_url TEXT,
	vk_date TEXT,
	comment_text TEXT,
	status TEXT NOT NULL DEFAULT 'new',
	error TEXT,
	indexed_at INTEGER
);

CREATE INDEX IF NOT EXISTS ix_packages_match ON packages (match_key);
CREATE INDEX IF NOT EXISTS ix_packages_status ON packages (status);

CREATE TABLE IF NOT EXISTS stats (
	package_id INTEGER PRIMARY KEY REFERENCES packages (id) ON DELETE CASCADE,
	started_games INTEGER NOT NULL DEFAULT 0,
	completed_games INTEGER NOT NULL DEFAULT 0,
	shown INTEGER NOT NULL DEFAULT 0,
	answered INTEGER NOT NULL DEFAULT 0,
	correct INTEGER NOT NULL DEFAULT 0,
	wrong INTEGER NOT NULL DEFAULT 0,
	right_percent REAL,
	take_percent REAL,
	level INTEGER,
	found INTEGER NOT NULL DEFAULT 0,
	updated_at INTEGER
);

CREATE INDEX IF NOT EXISTS ix_stats_level ON stats (level);

CREATE TABLE IF NOT EXISTS played (
	package_id INTEGER PRIMARY KEY REFERENCES packages (id) ON DELETE CASCADE,
	marked_at INTEGER NOT NULL
);

/* Запланированное: паки, отобранные на будущий вечер.

   Отдельная таблица, а не колонка в played, потому что это не состояние одной
   отметки, а две разные: «во что играли» — прошлое, «во что собираемся» —
   будущее, и пак вполне бывает и там, и там (сыграли, хотим ещё раз). Устроена
   она ровно как played, и по той же причине без хозяина: дома отметки
   принадлежат установке (см. LOCAL_USER_ID). */
CREATE TABLE IF NOT EXISTS planned (
	package_id INTEGER PRIMARY KEY REFERENCES packages (id) ON DELETE CASCADE,
	marked_at INTEGER NOT NULL
);

/* Авторы пака по одному в строке: иначе «Кот» находится внутри «Котовский». */
CREATE TABLE IF NOT EXISTS pack_authors (
	package_id INTEGER NOT NULL REFERENCES packages (id) ON DELETE CASCADE,
	author_key TEXT NOT NULL,
	author TEXT NOT NULL,
	PRIMARY KEY (package_id, author_key)
);

CREATE INDEX IF NOT EXISTS ix_pack_authors_key ON pack_authors (author_key);

/* Вошедшие через Discord. Ничего кроме имени и аватара не храним: сайту больше
   ничего и не нужно, а лишнее пришлось бы охранять. */
CREATE TABLE IF NOT EXISTS users (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	discord_id TEXT NOT NULL UNIQUE,
	username TEXT NOT NULL,
	global_name TEXT,
	avatar TEXT,
	created_at INTEGER NOT NULL,
	seen_at INTEGER NOT NULL
);

/* Входы. В базе лежит не сам ключ из куки, а его хеш: утёкшая база не должна
   давать возможности войти чужим именем. */
CREATE TABLE IF NOT EXISTS sessions (
	token_hash TEXT PRIMARY KEY,
	user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS ix_sessions_expires ON sessions (expires_at);

/* Оценки паков по десятибалльной шкале. Ключ пака — общий для всех его копий
   (см. packKey): один и тот же пак нередко выложен в обсуждение не раз, и делить
   оценки между копиями значило бы никогда не набрать порога показа. */
CREATE TABLE IF NOT EXISTS ratings (
	pack_key TEXT NOT NULL,
	user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	score INTEGER NOT NULL,
	rated_at INTEGER NOT NULL,
	PRIMARY KEY (pack_key, user_id)
);

CREATE INDEX IF NOT EXISTS ix_ratings_user ON ratings (user_id);

/* Настройки, которые ставятся из окна сайта, а не правкой файла: выбранная модель
   и тому подобное. Здесь, а не в config.js, потому что их меняют на ходу, и знать
   о них должен и сайт, и ночной обход, который запускается сам по себе. */
CREATE TABLE IF NOT EXISTS app_settings (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);

/* Сколько запросов к каждой модели потрачено за сутки. Считаем сами: сколько
   осталось от бесплатного лимита, Gemini не рассказывает никаким методом —
   про лимит он сообщает единственным способом, отказом, когда тот уже кончился.

   Сутки тут тихоокеанские: квоты Google сбрасываются в полночь по Лос-Анджелесу,
   и «сегодня» по местным часам разошлось бы со сбросом на полдня (см. quotaDay). */
CREATE TABLE IF NOT EXISTS gemini_usage (
	day TEXT NOT NULL,
	model TEXT NOT NULL,
	requests INTEGER NOT NULL DEFAULT 0,
	quota_hits INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (day, model)
);

/* Что мы узнали про модель на деле, а не из списка: суточный предел, названный
   самим Gemini в отказе (429 приносит QuotaFailure с quotaValue), и отказ работать
   вовсе — старые модели закрывают для новых ключей, и по списку доступных этого
   не видно никак (см. src/models.js). Живёт отдельно от расхода: расход про
   сегодня, а это знание о модели, и терять его при смене суток незачем. */
CREATE TABLE IF NOT EXISTS gemini_limits (
	model TEXT PRIMARY KEY,
	day_limit INTEGER,
	seen_at INTEGER NOT NULL
);

/* Личный чёрный список: kind = 'author' (author_key) или 'pack' (pack_key).
   Общего ЧС нет намеренно — это не модерация, а «не показывайте мне вот это». */
CREATE TABLE IF NOT EXISTS blacklist (
	user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	kind TEXT NOT NULL,
	value TEXT NOT NULL,
	label TEXT NOT NULL DEFAULT '',
	added_at INTEGER NOT NULL,
	PRIMARY KEY (user_id, kind, value)
);
`);

/**
 * Хозяин отметок, сделанных без входа. Отметка «сыграно» ничьей учётной записи
 * не требует, и чёрный список на своей машине — тоже (см. config.localBlacklist);
 * но лежать ему всё равно надо под каким-то пользователем, иначе связь с таблицей
 * users не позволит его записать. Это и есть тот пользователь: не Discord, а сама
 * установка. Строка заводится один раз и живёт пустой, пока в неё не запишут.
 *
 * Номер отрицательный не для красоты: настоящие номера раздаёт AUTOINCREMENT
 * с единицы, а ноль в JS ложен, и любая проверка «есть ли хозяин» молча решала
 * бы, что его нет.
 */
export const LOCAL_USER_ID = -1;

db.prepare(`
	INSERT OR IGNORE INTO users (id, discord_id, username, global_name, avatar, created_at, seen_at)
	VALUES (?, 'local', 'Этот компьютер', NULL, NULL, ?, ?)
`).run(LOCAL_USER_ID, Date.now(), Date.now());

// Дозаливка колонок в базы, созданные более ранней версией
const existingColumns = new Set(db.prepare(`PRAGMA table_info(packages)`).all().map(c => c.name));

for (const [name, definition] of [
	['tags_key', 'TEXT'],
	['topic_shares', `TEXT NOT NULL DEFAULT '{}'`],
	['primary_topic', 'TEXT'],
	['primary_share', 'REAL'],
	['topics_at', 'INTEGER'],
	['logo_file', 'TEXT'],
	['logo_state', 'TEXT'],
	['vk_ts', 'INTEGER'],
	// Версия правил разметки, по которым посчитаны доли: 1 — до появления мультфильмов
	['topics_version', 'INTEGER NOT NULL DEFAULT 1'],
	// Краткая суть пака от модели: «Вселенная Гарри Поттера», «Логотипы компаний»
	['summary', 'TEXT'],
	['summary_at', 'INTEGER'],
	// Кому пак: возраст аудитории промежутком и доля мужчин в процентах (женщины —
	// остальное до ста). Спрашивается тем же запросом, что и описание, и по тому же
	// списку тем. Это не статистика игроков — её не знает никто, — а оценка модели
	// по содержимому пака: по годам вышедших игр и фильмов, по интернет-культуре.
	['audience_from', 'INTEGER'],
	['audience_to', 'INTEGER'],
	['audience_male', 'INTEGER'],
	// «Про аудиторию уже спрашивали». Отдельно от значений, потому что модель
	// иногда не отвечает вовсе: без этой отметки такой пак переспрашивался бы
	// каждую ночь до скончания века. Отдельно от summary_at — потому что паки,
	// описанные до появления аудитории, надо переспросить ровно один раз.
	['audience_at', 'INTEGER'],
	// Франшизы, встретившиеся в паке больше одного раза: [{name, themes, questions, share}]
	['franchises', `TEXT NOT NULL DEFAULT '[]'`],
	// Чем оказалось «прочее»: [{key, questions, share}] — стримеры, история, спорт.
	// Только то, что взяло порог otherKindShare: остальное на карточке не пишется
	['other_kinds', `TEXT NOT NULL DEFAULT '[]'`],
	// Жанры внутри тематики пака: [{key, questions, share}] — рэп, исекай, шутеры.
	// Только у паков, которые чем-то одним и являются, и только то, что взяло
	// порог genreShare (см. computeGenres в src/topics.js)
	['genres', `TEXT NOT NULL DEFAULT '[]'`],
	// Из чьего списка эти жанры. Обычно то же, что primary_topic, но храним рядом:
	// пересчёт порогов (--recalc) меняет ярлык пака, не переспрашивая модель,
	// и без этой колонки жанры музпака, ставшего аниме-паком, читались бы
	// по чужому списку — «rap» превратился бы в невнятный ключ без имени
	['genre_topic', 'TEXT'],
	// Самая частая из них — вынесена отдельно, чтобы по ней можно было искать и сортировать
	['franchise_top', 'TEXT'],
	['franchise_top_share', 'REAL'],
	// Спецвопросы: сколько всего и каких — {auction: 4, cat: 2}. NULL значит
	// «пак разобран до того, как их научились считать», и это не то же самое,
	// что ноль: сайт про такой пак ничего не пишет, а не обещает, что их нет.
	['special_count', 'INTEGER'],
	['special_stat', 'TEXT'],
	// «Файл в сообщении подменили — разобрать заново». Отдельный признак, а не
	// возврат в состояние «новый»: пока новый разбор не готов, пак должен остаться
	// на сайте с прежним описанием. Снимается любым исходом разбора, удачным
	// или нет, — иначе сломанный файл переспрашивался бы каждую ночь до скончания
	// века (см. scanVk и parsePackages в indexer.js).
	['recheck', 'INTEGER NOT NULL DEFAULT 0'],
	// Какой моделью размечен пак и какой описан. Нужны, чтобы слабую разметку
	// можно было потом переспросить у сильной модели, не трогая уже хорошую
	// (см. --upgrade в indexer.js). NULL значит «размечено до появления колонки».
	['topics_model', 'TEXT'],
	['summary_model', 'TEXT'],
]) {
	if (!existingColumns.has(name)) {
		db.exec(`ALTER TABLE packages ADD COLUMN ${name} ${definition}`);
	}
}

// Дозаливка колонок в таблицу знаний о моделях
{
	const columns = new Set(db.prepare(`PRAGMA table_info(gemini_limits)`).all().map(c => c.name));

	for (const [name, definition] of [
		// Модель отказалась работать с этим ключом насовсем: «no longer available
		// to new users». Проверить это заранее нельзя — в списке доступных моделей
		// такая выглядит совершенно обычной
		['unavailable', 'INTEGER NOT NULL DEFAULT 0'],
		['note', 'TEXT'],
	]) {
		if (!columns.has(name)) {
			db.exec(`ALTER TABLE gemini_limits ADD COLUMN ${name} ${definition}`);
		}
	}
}

// Сообщение обсуждения целиком: по нему индексатор сверяет, не поменялось ли
// то, что в нём написано и приложено (см. scanVk). Без указателя эта сверка
// означала бы обход всей таблицы на каждое сообщение обсуждения.
db.exec('CREATE INDEX IF NOT EXISTS ix_packages_comment ON packages (vk_topic, vk_comment)');

db.exec('CREATE INDEX IF NOT EXISTS ix_packages_topic ON packages (primary_topic)');
db.exec('CREATE INDEX IF NOT EXISTS ix_packages_franchise ON packages (franchise_top)');
db.exec('CREATE INDEX IF NOT EXISTS ix_packages_vk_ts ON packages (vk_ts)');

// Указатели «покрывающие»: в них лежит и то, по чему ищут (status), и то, что
// при этом спрашивают. Разница не в поиске, а в том, что после него не нужно
// поднимать саму строку пака, — а строка эта тяжёлая: в ней лежат разобранные
// раунды, и весит она килобайты. Колонка слева считает типы, языки и темы
// по всей базе разом, и на каждый такой подсчёт база поднимала все строки
// целиком ради одного короткого поля. Теперь ответ целиком лежит в указателе.
//
// Те же указатели уезжают и в D1: выгрузка берёт их из этой базы (см.
// scripts/export-d1.js), а наверху они дороже вдвойне — там читанные строки
// не просто время, а расход по тарифу.
db.exec('CREATE INDEX IF NOT EXISTS ix_packages_ok_topic ON packages (status, primary_topic)');
db.exec('CREATE INDEX IF NOT EXISTS ix_packages_ok_lang ON packages (status, language)');
db.exec('CREATE INDEX IF NOT EXISTS ix_packages_ok_tags ON packages (status, tags)');
db.exec('CREATE INDEX IF NOT EXISTS ix_packages_ok_vk_ts ON packages (status, vk_ts)');

// Дополнительные типы паков — те, что целиком про один предмет (см. subjectPackShare).
// Колонка слева считает их по всей базе, и обе колонки, по которым идёт отбор,
// лежат прямо здесь: ответ собирается из указателя, не поднимая строк.
db.exec('CREATE INDEX IF NOT EXISTS ix_packages_ok_subject ON packages (status, franchise_top, franchise_top_share)');

// Журнал WAL растёт, пока его никто не подрезает, а подрезать его мешает любой
// открытый читатель — то есть сам сайт, который держит базу открытой сутками.
// Здесь он ещё никем не открыт, и это единственный надёжный миг всё сложить
// обратно в базу: к 6 МБ базы успевало накопиться 9 МБ журнала, и каждый обход
// таблицы шёл сначала по нему. Не вышло (базу занял индексатор) — не беда,
// вернётся ошибка занятости, и всё продолжит работать как прежде.
try {
	db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
} catch {
	// база занята другим процессом — журнал подрежется в другой раз
}

// Следы прежних попыток считать популярность за период: сначала по разнице числа
// игр, потом по дате из самого файла пака. Теперь период считается по времени
// появления пака в обсуждении (vk_ts), и ни то, ни другое больше не нужно.
db.exec('DROP TABLE IF EXISTS stats_history');
db.exec('DROP INDEX IF EXISTS ix_packages_date');

if (existingColumns.has('pack_date_iso')) {
	db.exec('ALTER TABLE packages DROP COLUMN pack_date_iso');
}

const VK_MONTHS = {
	янв: 0, фев: 1, мар: 2, апр: 3, мая: 4, май: 4, июн: 5,
	июл: 6, авг: 7, сен: 8, окт: 9, ноя: 10, дек: 11,
};

/**
 * Время сообщения ВК из того вида, в каком его показывает страница обсуждения:
 * «7 авг 2026 в 13:51», «12 июл в 21:33» (год опущен — значит текущий),
 * «сегодня в 0:34», «вчера в 20:26». Возвращает миллисекунды или null.
 *
 * Через VK API этого разбора не нужно — там время приходит числом (см. vkapi.js),
 * но без ключа обсуждения читаются как обычные страницы, и другого источника нет.
 *
 * @param at к какому моменту относятся «сегодня» и «вчера»: строку разбираем
 *   тогда же, когда прочитали страницу, поэтому по умолчанию это «сейчас».
 */
export function parseVkDate(raw, at = Date.now()) {
	const text = (raw ?? '').trim().toLowerCase();

	if (!text) {
		return null;
	}

	// Не \bв\s+…: \b в JS считает границу слова по латинице, и перед кириллическим
	// «в» её нет — время просто не находилось, а у всех сообщений выходил полдень.
	const time = /(?:^|\s)в\s+(\d{1,2}):(\d{2})/.exec(text);
	const hours = time ? Number(time[1]) : 12;
	const minutes = time ? Number(time[2]) : 0;

	const relative = /^(сегодня|вчера)/.exec(text);

	if (relative) {
		const day = new Date(at);
		day.setHours(hours, minutes, 0, 0);

		if (relative[1] === 'вчера') {
			day.setDate(day.getDate() - 1);
		}

		return day.getTime();
	}

	const parts = /^(\d{1,2})\s+([а-яё]+)\.?(?:\s+(\d{4}))?/.exec(text);

	if (!parts) {
		return null;
	}

	const month = VK_MONTHS[parts[2].slice(0, 3)];

	if (month === undefined) {
		return null;
	}

	const year = parts[3] ? Number(parts[3]) : new Date(at).getFullYear();

	return new Date(year, month, Number(parts[1]), hours, minutes).getTime();
}

const readSetting = db.prepare('SELECT value FROM app_settings WHERE key = ?');
const writeSetting = db.prepare(`
	INSERT INTO app_settings (key, value) VALUES (?, ?)
	ON CONFLICT (key) DO UPDATE SET value = excluded.value
`);

/** Настройка, поставленная из окна сайта. Не поставлена — вернётся fallback. */
export function getSetting(key, fallback = null) {
	return readSetting.get(key)?.value ?? fallback;
}

export function setSetting(key, value) {
	writeSetting.run(key, String(value));
}

const deleteAuthors = db.prepare('DELETE FROM pack_authors WHERE package_id = ?');
const insertAuthor = db.prepare('INSERT OR IGNORE INTO pack_authors (package_id, author_key, author) VALUES (?, ?, ?)');

/**
 * Переписывает авторов пака. Вызывается после каждого разбора.
 *
 * Составная подпись разбирается на людей: «Vieldy,Pa4ok,Slime» — это трое,
 * и в таблице им место по строке на каждого (см. splitAuthors). Иначе паки
 * Vieldy по его имени не находились, а в топе авторов такое сочетание стояло
 * отдельной строкой, никак не связанной с самими Vieldy и Pa4ok.
 *
 * В самой колонке packages.authors подпись при этом остаётся ровно такой, как
 * записана в файле: по ней пак ищется в сервисе статистики SIGame, и там его
 * знают именно под ней (см. fetchPackageStats).
 */
export function saveAuthors(packageId, authors) {
	deleteAuthors.run(packageId);

	for (const author of splitAuthors(authors)) {
		const key = buildAuthorKey(author);

		if (key) {
			insertAuthor.run(packageId, key, author.trim());
		}
	}
}

// Одноразовая дозаливка ключа тегов для уже разобранных паков
{
	const rows = db.prepare(`SELECT id, tags FROM packages WHERE tags_key IS NULL AND status = 'ok'`).all();

	if (rows.length > 0) {
		const update = db.prepare('UPDATE packages SET tags_key = ? WHERE id = ?');

		for (const row of rows) {
			update.run(buildTagsKey(jsonOrDefault(row.tags, [])), row.id);
		}
	}
}

// Одноразовая заливка таблицы авторов для паков, разобранных до её появления
{
	const missing = db.prepare(`
		SELECT p.id, p.authors FROM packages p
		WHERE p.status = 'ok' AND p.authors <> '[]'
			AND NOT EXISTS (SELECT 1 FROM pack_authors a WHERE a.package_id = p.id)
	`).all();

	for (const row of missing) {
		saveAuthors(row.id, jsonOrDefault(row.authors, []));
	}
}

// Разбор составных подписей для паков, записанных до того, как их научились
// разбирать: «Vieldy,Pa4ok,Slime» лежало в таблице одной строкой. Переписываем
// только тех, у кого разбор что-то меняет, — сравнением набора ключей: перебирать
// полторы тысячи паков дешевле, чем оставить половину авторов ненажимаемыми,
// а переиндексация ради этого не нужна вовсе, подпись уже лежит в базе.
{
	const rows = db.prepare(`
		SELECT p.id, p.authors,
			(SELECT GROUP_CONCAT(a.author_key, CHAR(10)) FROM (
				SELECT author_key FROM pack_authors WHERE package_id = p.id ORDER BY author_key
			) a) AS stored
		FROM packages p
		WHERE p.status = 'ok' AND p.authors <> '[]'
	`).all();

	let fixed = 0;

	for (const row of rows) {
		const wanted = splitAuthors(jsonOrDefault(row.authors, []))
			.map(buildAuthorKey)
			.filter(Boolean)
			.sort()
			.join('\n');

		if (wanted !== (row.stored ?? '')) {
			saveAuthors(row.id, jsonOrDefault(row.authors, []));
			fixed++;
		}
	}

	if (fixed > 0) {
		console.log(`Составных подписей авторов разобрано: ${fixed}.`);
	}
}

// Время сообщения для паков, собранных до появления колонки. Заново обходить
// обсуждение не нужно: строка вида «7 авг 2026 в 13:51» всё это время лежала
// в vk_date. «Сегодня» и «вчера» в ней считаются от того дня, когда пак попал
// в базу, а не от сегодняшнего: тогда эта строка и была написана.
{
	const rows = db.prepare(`
		SELECT id, vk_date, indexed_at FROM packages
		WHERE vk_ts IS NULL AND vk_date IS NOT NULL AND vk_date <> ''
	`).all();

	if (rows.length > 0) {
		const update = db.prepare('UPDATE packages SET vk_ts = ? WHERE id = ?');

		for (const row of rows) {
			update.run(parseVkDate(row.vk_date, row.indexed_at ?? Date.now()), row.id);
		}
	}
}

// Уровень сложности пересчитывается при запуске: пороги живут в config.js, и правка
// руками должна сразу отражаться на сайте, а не ждать следующего обхода статистики.
// Правило то же, что в stats.js: toLevel().
{
	const minGames = Number(config.minGamesForDifficulty);
	const minShown = Number(config.minShownForDifficulty);
	const { easy, medium, hard } = config.difficultyThresholds;

	// Ступень вниз за низкую долю правильных ответов — то же правило, что в toLevel():
	// отвечать решаются, но отвечают мимо, и пак труднее, чем показывает процент попыток.
	const levelCase = `CASE
		WHEN take_percent IS NULL THEN NULL
		WHEN started_games < ${minGames} THEN NULL
		WHEN shown < ${minShown} THEN NULL
		ELSE MAX(1, (CASE
			WHEN take_percent > ${Number(easy)} THEN 4
			WHEN take_percent >= ${Number(medium)} THEN 3
			WHEN take_percent >= ${Number(hard)} THEN 2
			ELSE 1
		END) - (CASE
			WHEN right_percent IS NOT NULL AND right_percent < ${Number(config.hardRightPercent)} THEN 1
			ELSE 0
		END))
	END`;

	db.exec(`UPDATE stats SET level = ${levelCase} WHERE level IS NOT (${levelCase})`);
}
