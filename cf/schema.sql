-- Таблицы, которые заводятся в D1 один раз и живут своей жизнью.
--
-- Здесь лежит всё, что накопили посетители: кто вошёл, кто что оценил, кто что
-- спрятал, кто во что играл. Сама база паков сюда не входит нарочно — её
-- каждый раз заливают заново из домашней sibase.db (см. scripts/export-d1.js),
-- и будь оценки в том же файле, очередная заливка стирала бы их подчистую.
--
-- Отсюда же и IF NOT EXISTS: этот файл прогоняется перед каждой выкладкой,
-- и второй прогон обязан ничего не сделать.

-- Вошедшие через Discord. Ничего кроме имени и аватара не храним: сайту больше
-- ничего и не нужно, а лишнее пришлось бы охранять.
CREATE TABLE IF NOT EXISTS users (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	discord_id TEXT NOT NULL UNIQUE,
	username TEXT NOT NULL,
	global_name TEXT,
	avatar TEXT,
	created_at INTEGER NOT NULL,
	seen_at INTEGER NOT NULL
);

-- Входы. В базе лежит не сам ключ из куки, а его хеш: утёкшая база не должна
-- давать возможности войти чужим именем.
CREATE TABLE IF NOT EXISTS sessions (
	token_hash TEXT PRIMARY KEY,
	user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS ix_sessions_expires ON sessions (expires_at);

-- Оценки паков по десятибалльной шкале.
CREATE TABLE IF NOT EXISTS ratings (
	pack_key TEXT NOT NULL,
	user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	score INTEGER NOT NULL,
	rated_at INTEGER NOT NULL,
	PRIMARY KEY (pack_key, user_id)
);

CREATE INDEX IF NOT EXISTS ix_ratings_user ON ratings (user_id);

-- Личный чёрный список: kind = 'author' (author_key) или 'pack' (pack_key).
-- Общего ЧС нет намеренно — это не модерация, а «не показывайте мне вот это».
CREATE TABLE IF NOT EXISTS blacklist (
	user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	kind TEXT NOT NULL,
	value TEXT NOT NULL,
	label TEXT NOT NULL DEFAULT '',
	added_at INTEGER NOT NULL,
	PRIMARY KEY (user_id, kind, value)
);

-- Отметки «сыграно». Дома они принадлежат установке и лежат по номеру строки
-- в таблице паков; здесь у каждой обязан быть хозяин — иначе один отметил бы,
-- а погасло бы у всех, — и лежат они по общему ключу пака, а не по номеру.
--
-- Ключ вместо номера здесь не мелочь. Номера раздаёт AUTOINCREMENT домашней
-- базы, и очередная заливка вполне может выдать тому же паку другой: отметки,
-- привязанные к номерам, после такой заливки указывали бы на чужие паки.
-- Ключ же считается из самого файла (см. src/keys.js) и переживает заливку,
-- а заодно накрывает все копии пака разом — как и оценка, и чёрный список.
CREATE TABLE IF NOT EXISTS played (
	user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	pack_key TEXT NOT NULL,
	marked_at INTEGER NOT NULL,
	PRIMARY KEY (user_id, pack_key)
);

CREATE INDEX IF NOT EXISTS ix_played_key ON played (pack_key);

-- Запланированное: паки, отобранные на будущий вечер. Устроено ровно как
-- played, и по тем же причинам — хозяин обязателен, ключ вместо номера.
--
-- Отдельная таблица, а не признак у played, потому что это не состояние одной
-- отметки, а две разные: «во что играли» — прошлое, «во что собираемся» —
-- будущее, и пак вполне бывает и там, и там сразу.
CREATE TABLE IF NOT EXISTS planned (
	user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	pack_key TEXT NOT NULL,
	marked_at INTEGER NOT NULL,
	PRIMARY KEY (user_id, pack_key)
);

CREATE INDEX IF NOT EXISTS ix_planned_key ON planned (pack_key);
