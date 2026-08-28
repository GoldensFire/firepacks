-- Таблицы, которые заводятся в D1 один раз и живут своей жизнью.
--
-- Здесь лежит всё, что накопили посетители: кто вошёл, кто что оценил, кто что
-- спрятал, кто во что играл. Сама база паков сюда не входит нарочно — её
-- каждый раз заливают заново из домашней sibase.db (см. scripts/export-d1.js),
-- и будь оценки в том же файле, очередная заливка стирала бы их подчистую.
--
-- Отсюда же и IF NOT EXISTS: этот файл прогоняется перед каждой выкладкой,
-- и второй прогон обязан ничего не сделать.

-- Вошедшие. Ничего кроме имени и аватара не храним: сайту больше ничего
-- и не нужно, а лишнее пришлось бы охранять.
--
-- Входов два, Discord и ВК, и у человека может быть заведён как один, так
-- и оба: колонки discord_id и vk_id обе необязательны, но пустыми сразу
-- обе не бывают — строка тогда никому не принадлежала бы. UNIQUE на каждой
-- и есть то, что не даёт завести двух хозяев одной странице ВК или одному
-- аккаунту Discord.
--
-- Почему это одна таблица с двумя колонками, а не «пользователи» и «входы»
-- порознь. Входов ровно два и третьего не предвидится; таблица на две строки
-- про один и тот же вход стоила бы лишнего чтения D1 при каждом открытии
-- страницы — а именно этим запросом начинается любое обращение к сайту
-- (см. currentUser в cf/src/auth/session.js).
--
-- Страницы ВК, признанные своими, лежат отдельно (user_vk) — их у человека
-- бывает несколько, и это уже не про вход, а про авторство.
--
-- ————— как эта таблица получилась у уже живущей базы —————
--
-- Здесь она заводится в готовом виде — то есть только на чистой базе. У той,
-- что работает с прошлого года, discord_id стоит NOT NULL, и снять это ALTER'ом
-- SQLite не умеет: таблицу надо пересобрать. Такое делается однажды и руками
-- (`npm run cf:migrate-auth`, файл cf/migrate-auth.sql), а не этим файлом,
-- который прогоняется перед каждой выкладкой: пересборка таблицы посетителей
-- каждую ночь — это триста шестьдесят пять возможностей их потерять в год
-- ради одной правки.
CREATE TABLE IF NOT EXISTS users (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	discord_id TEXT UNIQUE,
	vk_id TEXT UNIQUE,
	username TEXT NOT NULL,
	global_name TEXT,
	avatar TEXT,
	created_at INTEGER NOT NULL,
	seen_at INTEGER NOT NULL
);

-- ————— страницы ВК, признанные своими —————
--
-- Одна строка на страницу; у человека их бывает несколько — первую он получает
-- входом через ВК, остальные привязывает в настройках профиля. Это и есть
-- ответ на вопрос «его ли это паки»: подпись под паком считается подтверждённой,
-- когда номер страницы, к которой её свёл обход (pack_authors.canon_account),
-- лежит здесь за этим человеком (см. cf/src/library/authorship.js).
--
-- vk_id первичным ключом, а не парой с хозяином: одна страница ВК не может
-- принадлежать двоим — иначе авторство подтверждали бы вдвоём, по очереди.
CREATE TABLE IF NOT EXISTS user_vk (
	vk_id TEXT PRIMARY KEY,
	user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	added_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_user_vk_user ON user_vk (user_id);

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

-- ————— переезд отметок на новый ключ пака —————
--
-- Ключ пака раньше складывался из идентификатора внутри файла и названия,
-- а теперь это номер оставшегося пака (см. packKey в src/keys.js). Правило
-- сменилось потому, что старое склеивало разные паки в один: у МакКайлы
-- четырнадцать паков с одним идентификатором и одним названием «Вопросы SIGame»,
-- у автора «Different» таких двадцать два. Всё, что посетители про такой пак
-- сказали, лежало под общим ключом на всю пачку.
--
-- Оценки, отметки «сыграно», отложенное и чёрный список живут только здесь —
-- домашняя база их не знает, и заливка их не трогает. Значит, и переложить их
-- на новый ключ можно только отсюда.
--
-- Как узнаётся старый ключ: в нём стоит перевод строки — он разделял
-- идентификатор и название. У нового ключа это просто число, и переводу строки
-- в нём взяться неоткуда. Поэтому второй прогон не находит ни одной строки,
-- и файл этот остаётся тем, чем был, — прогоняемым перед каждой выкладкой
-- и ничего не делающим со второго раза.
--
-- Какому паку достаётся отметка, когда старый ключ был общим на четырнадцать:
-- самому раннему. Разобрать, какой из них человек имел в виду, нельзя вовсе —
-- ключ был один, — а самый ранний и есть тот, что на сайте показывался.
--
-- Отметка от пропавшего пака остаётся при старом ключе: подставить ей NULL
-- нельзя (колонка обязательная), а придумать номер неоткуда. Такая строка мертва
-- и была мертва до всякого переезда.
--
-- «UPDATE OR REPLACE» — на случай, когда у одного и того же человека две отметки
-- сходятся в одну: пусть останется одна, чем не пройдёт весь запрос.

UPDATE OR REPLACE ratings SET pack_key = (
	SELECT CAST(MIN(p.id) AS TEXT) FROM packages p
	WHERE TRIM(p.pack_id) || CHAR(10) || TRIM(COALESCE(p.name, '')) = ratings.pack_key
)
WHERE instr(pack_key, CHAR(10)) > 0 AND EXISTS (
	SELECT 1 FROM packages p
	WHERE TRIM(p.pack_id) || CHAR(10) || TRIM(COALESCE(p.name, '')) = ratings.pack_key
);

UPDATE OR REPLACE played SET pack_key = (
	SELECT CAST(MIN(p.id) AS TEXT) FROM packages p
	WHERE TRIM(p.pack_id) || CHAR(10) || TRIM(COALESCE(p.name, '')) = played.pack_key
)
WHERE instr(pack_key, CHAR(10)) > 0 AND EXISTS (
	SELECT 1 FROM packages p
	WHERE TRIM(p.pack_id) || CHAR(10) || TRIM(COALESCE(p.name, '')) = played.pack_key
);

UPDATE OR REPLACE planned SET pack_key = (
	SELECT CAST(MIN(p.id) AS TEXT) FROM packages p
	WHERE TRIM(p.pack_id) || CHAR(10) || TRIM(COALESCE(p.name, '')) = planned.pack_key
)
WHERE instr(pack_key, CHAR(10)) > 0 AND EXISTS (
	SELECT 1 FROM packages p
	WHERE TRIM(p.pack_id) || CHAR(10) || TRIM(COALESCE(p.name, '')) = planned.pack_key
);

-- В чёрном списке ключ пака лежит только у строк kind = 'pack': у автора
-- там его подпись, и перевода строки в ней не бывает, но условие всё равно
-- стоит явно — читающему этот файл не придётся об этом догадываться.
UPDATE OR REPLACE blacklist SET value = (
	SELECT CAST(MIN(p.id) AS TEXT) FROM packages p
	WHERE TRIM(p.pack_id) || CHAR(10) || TRIM(COALESCE(p.name, '')) = blacklist.value
)
WHERE kind = 'pack' AND instr(value, CHAR(10)) > 0 AND EXISTS (
	SELECT 1 FROM packages p
	WHERE TRIM(p.pack_id) || CHAR(10) || TRIM(COALESCE(p.name, '')) = blacklist.value
);

-- ————— комментарии к пакам —————
--
-- Лежат по общему ключу пака (COALESCE(copy_of, id) строкой) — по тому же,
-- по которому лежат оценки и отметки, и ровно по той же причине: у пака бывают
-- копии, разговор у них общий, а номера строк переживают не всякую заливку.
--
-- Удалённое не стирается, а помечается временем в deleted_at: на комментарий
-- ссылаются лайки, а у автора и у модератора должно оставаться место, куда
-- смотреть, когда спорят, что именно было написано. Наружу такие строки
-- не отдаются вовсе.
--
-- Правка хранится двумя полями: body — то, что видно сейчас, original — то,
-- что было написано в первый раз. Второе заполняется ровно один раз, при первой
-- же правке, и дальше не трогается: показывать под наводкой надо исходное,
-- а не предпоследнее. Ни разу не правленный комментарий держит здесь NULL.
CREATE TABLE IF NOT EXISTS comments (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	pack_key TEXT NOT NULL,
	user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	body TEXT NOT NULL,
	original TEXT,
	created_at INTEGER NOT NULL,
	edited_at INTEGER,
	deleted_at INTEGER,
	deleted_by INTEGER
);

-- Указатель составной и не случайно: страница пака спрашивает разом «чьи это»
-- и «в каком порядке», а живые от удалённых отделяет deleted_at. По одному
-- pack_key планировщик D1 (у которого нет sqlite_stat1 и который выбирает
-- указатель наугад) складывал бы найденное в память ради сортировки.
CREATE INDEX IF NOT EXISTS ix_comments_pack ON comments (pack_key, deleted_at, created_at);

-- А этот — для частоты отправки и для поиска дублей: оба вопроса задаются
-- про одного человека и про последние его строки (см. cf/src/library/spam.js).
CREATE INDEX IF NOT EXISTS ix_comments_user ON comments (user_id, created_at);

-- Лайки комментариев. Один человек — один лайк, отсюда и составной ключ:
-- второе нажатие снимает своё, а не добавляет ещё одно.
CREATE TABLE IF NOT EXISTS comment_likes (
	comment_id INTEGER NOT NULL REFERENCES comments (id) ON DELETE CASCADE,
	user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	liked_at INTEGER NOT NULL,
	PRIMARY KEY (comment_id, user_id)
);

CREATE INDEX IF NOT EXISTS ix_comment_likes_user ON comment_likes (user_id);

-- ————— наказания —————
--
-- Одна строка на человека, а не журнал: у наказания нет истории, у него есть
-- нынешнее состояние — «молчит до среды» или «забанен». Снятие удаляет строку.
--
-- kind: 'mute' — нельзя писать комментарии; 'ban' — нельзя ничего, что человек
-- оставляет от своего имени: ни комментариев, ни лайков, ни оценок.
-- until: до какого времени, NULL — бессрочно. Мут без срока тоже бывает,
-- и это не то же самое, что бан: бан снимает и оценки тоже.
CREATE TABLE IF NOT EXISTS punishments (
	user_id INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
	kind TEXT NOT NULL,
	until INTEGER,
	reason TEXT NOT NULL DEFAULT '',
	set_at INTEGER NOT NULL,
	set_by INTEGER
);

-- ————— паки, снятые с публикации —————
--
-- Сам запрет живёт не здесь, а в самой строке пака: у неё становится
-- status = 'hidden', и пак пропадает разом отовсюду — из выдачи, из поиска,
-- из счётчиков, из карты сайта, со своей страницы, — потому что все запросы
-- сайта и так спрашивают status = 'ok'. Ни одного нового условия в них
-- добавлять не пришлось, а значит, и ни одной лишней прочитанной строки:
-- у D1 они считаны по тарифу (см. cf/src/library/counts.js).
--
-- Тогда зачем таблица. Затем, что таблица packages приезжает из домашней базы
-- и переписывается заливкой (см. scripts/export-d1.js), а домашняя база про
-- снятые паки не знает вовсе: там нет ни модерации, ни посетителей. Первая же
-- заливка изменившегося пака вернула бы ему status = 'ok'. Здесь лежит список,
-- по которому запрет накладывается заново после каждой заливки — этим и занят
-- cf/hidden.sql, который выкладка прогоняет сразу за паками.
CREATE TABLE IF NOT EXISTS hidden_packs (
	pack_key TEXT PRIMARY KEY,
	reason TEXT NOT NULL DEFAULT '',
	hidden_at INTEGER NOT NULL,
	hidden_by INTEGER
);

-- ————— уведомления —————
--
-- Колокольчик в шапке: кому и о чём сайт должен сказать, когда тот придёт
-- в следующий раз. Ни почты, ни пушей — только значок у профиля.
--
-- kind: 'comment' — написали под паком, чьё авторство за этим человеком
-- подтверждено; 'reply' — написали под паком, где он и сам писал; 'like' —
-- лайкнули его комментарий; 'admin' — новый комментарий на сайте, это
-- уведомление получает хозяин.
--
-- Почему 'reply', а не «ответ». Ответов в разговоре под паком нет вовсе:
-- он плоский, ветки в нём не заводятся (см. cf/src/library/comments.js).
-- Ближайшее, что здесь значит то же самое, — «в разговоре, где ты участвовал,
-- появилось новое»; так эта строка и читается.
--
-- Своих действий человек не получает: положить строку самому себе — значит
-- звенеть на собственный комментарий. Это отсекается при записи
-- (см. cf/src/library/notifications.js), а не здесь: условие с двумя колонками
-- одной таблицы SQLite в CHECK бы и принял, но объяснение ему место рядом
-- с тем, кто пишет.
--
-- read_at: когда прочитано, NULL — ещё нет. Прочитанное не стирается сразу
-- (человек открыл список и хочет посмотреть, что было), а подчищается
-- по сроку — иначе таблица растёт вечно.
CREATE TABLE IF NOT EXISTS notifications (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	kind TEXT NOT NULL,
	pack_key TEXT NOT NULL DEFAULT '',
	comment_id INTEGER,
	actor_id INTEGER,
	created_at INTEGER NOT NULL,
	read_at INTEGER
);

-- Указатель составной и ровно под тот вопрос, который задаётся на каждой
-- открытой странице: «сколько непрочитанного у этого человека». read_at
-- вторым полем — по нему и отсекается прочитанное, не поднимая его строк;
-- created_at третьим — список отдаётся свежим вперёд, и сортировать в памяти
-- уже нечего.
CREATE INDEX IF NOT EXISTS ix_notifications_user ON notifications (user_id, read_at, created_at);

-- А этот — для подчистки прочитанного по сроку: она спрашивает про всех разом
-- и только по времени.
CREATE INDEX IF NOT EXISTS ix_notifications_read ON notifications (read_at);
