// Рабочее состояние базы: как оно ездит между этим компьютером и GitHub.
//
//   node scripts/state.js status   что лежит на полке и что здесь
//   node scripts/state.js sync     подогнать здешнее под полку (это делает запуск сайта)
//   node scripts/state.js pull     забрать полку к себе
//   node scripts/state.js push     отдать своё на полку
//   node scripts/state.js merge <файл>  влить разметку из другой копии базы
//
// Зачем это вообще. Ночной обход переехал в GitHub Actions, а там нет ничего
// постоянного: каждая ночь начинается с пустой машины, которая через двадцать
// минут исчезает вместе со всем, что на ней было. Базу негде хранить между
// запусками — значит, её надо привозить с собой и увозить обратно.
//
// Где она лежит между ночами: в приложении к отметке релиза в самом репозитории.
// Не в самом репозитории: база на пятнадцати тысячах паков весит под двести
// мегабайт, и складывать её в историю правок означало бы держать там каждую
// её ночную версию навсегда. Приложение же просто перезаписывается, и место
// занимает только последнее. Ключей для этого не нужно никаких: у Actions есть
// свой пропуск в собственный репозиторий.
//
// Что именно ездит:
//   data/sibase.db  — сама база;
//   data/thumbs     — готовые уменьшенные обложки.
//
// Оригиналы обложек (data/logos) не ездят: их семьдесят мегабайт на четыре сотни
// паков, то есть больше двух гигабайт на пятнадцать тысяч, — а нужны они ровно
// один раз, чтобы сделать уменьшенную копию. Копии и ездят; см. scripts/build-web.js.
//
// ── Кто здесь главный ──
//
// Полка. Не эта машина. Паки собирает ночной обход в облаке, и то, что лежит
// на полке, — это ровно то, из чего собран сайт. Поэтому здешняя база не «своя
// отдельная», а копия полки, и запуск сайта начинается со сверки (см. sync):
// разошлось — забираем полку. Прежняя здешняя база при этом не пропадает,
// а отодвигается в data/sibase.prev.db, — но идти в дело она больше не идёт.
//
// Обратный ход один и он же единственный: выкладка на сайт (scripts/deploy-cf.js)
// после удачной заливки сама кладёт базу на полку. То есть наверх уезжает не
// «что-то, над чем тут работали», а ровно то, что уже стоит на сайте.
//
// ── Чего «полка главная» не означает ──
//
// Что работу этой машины можно выбросить. Разметку делает не только полка:
// здесь запускают обновление базы, и это самая дорогая работа в проекте —
// не по времени, а по суточной квоте Gemini. Поэтому подмена базы её больше
// не выбрасывает, а переносит, и отправка на полку — не затирает, а сливает.
// Правило в обе стороны одно: у кого разметка свежее, того и ответ, кто бы
// её ни сделал (см. MARKUP, carryMarkup и mergeShelf ниже).
//
// Всё остальное по-прежнему решает полка целиком: строки паков, статистика,
// авторы, отметка о выгрузке. Спорить тут не о чем — их собирает обход
// обсуждений, а он один и тот же с обеих сторон.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Отметка релиза, к которой прикладывается состояние. Одна на всё время. */
const TAG = 'state';

/**
 * Имя приложения. Совпадает с именем файла в WORK нарочно: gh называет приложение
 * по файлу, который ему дали, и переименовать его при отправке нечем.
 */
const ASSET = 'state.tgz';

/**
 * Где свёрток лежит, пока его собирают или разворачивают. Место выбрано внутри
 * проекта, и путь ниже всюду относительный, — это не прихоть.
 *
 * В Windows на пути обычно оказывается tar из состава Git, а он ведёт себя
 * как в юниксе: путь с двоеточием для него не «диск C», а «машина C в сети»,
 * и на «C:\Users\…» он честно пытается куда-то дозвониться. Относительному пути
 * двоеточие взяться неоткуда, и обе разновидности tar понимают его одинаково.
 */
const WORK = 'data/state.tgz';

/** Куда снимается копия базы перед укладкой в свёрток; см. snapshot. */
const STAGE = 'data/state-stage';

const dbPath = path.join(root, 'data', 'sibase.db');
const prevPath = path.join(root, 'data', 'sibase.prev.db');
const thumbsPath = path.join(root, 'data', 'thumbs');

/**
 * Чем здешняя база помечена: какой свёрток с полки в ней развёрнут. Сверять
 * по времени файла нельзя — сайт пишет в базу на каждый вход и каждую отметку
 * «сыграно», и она оказывается «новее» полки, ничего нового про паки не зная.
 * Отпечаток же приложения меняется тогда и только тогда, когда полка сменилась.
 */
const MARK = path.join(root, 'data', 'state-mark.json');

/**
 * Таблицы, которые принадлежат этой машине, а не полке: кто сюда входил, что
 * отмечено сыгранным, какие оценки поставлены здесь. Полка их тоже везёт (они
 * лежат в той же базе), но приезжают они с прошлого раза и всегда старее
 * здешних — поэтому после подмены базы здешние возвращаются на место.
 *
 * Оценки и отметки с настоящего сайта здесь ни при чём: те живут в Cloudflare
 * и заливкой не трогаются вовсе (см. cf/schema.sql).
 */
const PERSONAL = ['users', 'sessions', 'ratings', 'played', 'blacklist'];

/**
 * Работа Gemini, которую нельзя терять при подмене базы.
 *
 * Полка — главная, и это правильно во всём, кроме одного: разметку делает
 * не только полка. Её делает и эта машина, когда здесь запускают обновление
 * базы, и работа эта самая дорогая, какая в проекте есть, — не по времени,
 * а по суточной квоте, которой на всё про всё пятьсот запросов.
 *
 * До сих пор она пропадала молча и целиком. 18 августа 2026 здесь домолотили
 * очередь до 291 неразмеченного пака; наверх это уехало, а на полку — нет
 * (полку в тот же час переписал ежечасный обход, и push отказался её затирать).
 * Вечером запуск сайта сверился с полкой, увёл здешнюю базу в sibase.prev.db
 * и поставил на её место полочную — с 923 неразмеченными. Шестьсот тридцать
 * два пака разметки выброшено, и не сказано об этом ни слова: сверка сравнивает
 * число разобранных паков, а разобраны были все и там, и там.
 *
 * Поэтому теперь при подмене разметка переносится, а не выбрасывается. Правило
 * одно и то же в обе стороны: у кого отметка времени свежее, того и разметка.
 * Кто её сделал — эта машина или ночной обход — значения не имеет и иметь
 * не должно.
 *
 * Разбито на два куска потому, что делаются они порознь и порознь же отмечаются:
 * ярлык с долями ставит шаг «разметка», описание с аудиторией — шаг «описание»,
 * и пак сплошь и рядом имеет одно без другого.
 */
const MARKUP = [
	{
		name: 'разметка',
		at: 'topics_at',
		columns: [
			'topic_shares', 'primary_topic', 'primary_share', 'topics_at', 'topics_version', 'topics_model',
			'franchises', 'franchise_top', 'franchise_top_share', 'other_kinds',
			'genres', 'genre_topic', 'forms', 'form_topic', 'form_coverage',
			'language_ai', 'decades', 'decade_coverage', 'origins', 'origin_coverage',
		],
	},
	{
		name: 'описание',
		at: 'summary_at',
		columns: ['summary', 'summary_at', 'summary_model', 'audience_from', 'audience_to', 'audience_male', 'audience_at'],
	},
];

const command = process.argv[2] ?? 'status';
const force = process.argv.includes('--force');

/**
 * Запуск с выводом наружу. Возвращает код, а не падает: у каждой команды здесь
 * своя реакция на неудачу, и общее «умереть» ни одной не подходит.
 */
function run(program, args, options = {}) {
	// Без оболочки нарочно. В Windows она склеивает список доводов в одну строку,
	// не расставляя кавычек, и «--title Рабочее состояние базы» приезжает к gh
	// как заголовок «Рабочее» и два непонятно чьих слова следом. Запускаем здесь
	// только gh и tar — обе настоящие программы, и оболочка для них не нужна.
	const result = spawnSync(program, args, {
		cwd: root,
		stdio: options.quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
		encoding: 'utf8',
	});

	return { code: result.status ?? 1, out: (result.stdout ?? '').trim(), err: (result.stderr ?? '').trim() };
}

const haveGh = () => run('gh', ['--version'], { quiet: true }).code === 0;

function requireGh() {
	if (!haveGh()) {
		console.error('Нет gh — это команда GitHub. Поставьте её (winget install GitHub.cli) и войдите: gh auth login');
		process.exit(1);
	}
}

/** Что лежит на полке: время, размер и отпечаток. null — там ещё ничего нет. */
function remoteAsset() {
	const result = run('gh', ['release', 'view', TAG, '--json', 'assets'], { quiet: true });

	if (result.code !== 0) {
		return null;
	}

	try {
		const assets = JSON.parse(result.out).assets ?? [];
		return assets.find(asset => asset.name === ASSET) ?? null;
	} catch {
		return null;
	}
}

/**
 * Чем один свёрток отличается от другого. Обычно это sha256, который GitHub
 * считает сам; старые gh его не показывают — тогда сойдёт пара «время и размер»:
 * приложение перезаписывается целиком, и совпасть у разных свёртков ей неоткуда.
 */
const assetId = asset => asset.digest || `${asset.updatedAt}|${asset.size}`;

function readMark() {
	try {
		return JSON.parse(fs.readFileSync(MARK, 'utf8'));
	} catch {
		return null;
	}
}

function writeMark(asset) {
	fs.writeFileSync(MARK, `${JSON.stringify({
		id: assetId(asset),
		updatedAt: asset.updatedAt,
		size: asset.size,
		at: new Date().toISOString(),
	}, null, '\t')}\n`, 'utf8');
}

function localStamp() {
	try {
		const stat = fs.statSync(dbPath);
		return { at: stat.mtime, size: stat.size };
	} catch {
		return null;
	}
}

const megabytes = bytes => `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
const when = value => new Date(value).toLocaleString('ru-RU');

/** Путь для SQL. Обратные косые Windows внутри строки SQLite не мешают, но прямые понятнее. */
const sqlPath = file => file.split(path.sep).join('/').replace(/'/g, "''");

/**
 * Сколько в базе паков. Нужно ровно затем, чтобы после подмены сказать вслух,
 * что именно приехало: «было 9199, стало 11387» — единственная строка, по которой
 * видно, что сверка вообще работает.
 */
function contentOf(file) {
	if (!fs.existsSync(file)) {
		return null;
	}

	try {
		const db = new DatabaseSync(file, { readOnly: true });

		try {
			return db.prepare(`
				SELECT (SELECT count(*) FROM packages) AS packs,
				       (SELECT count(*) FROM packages WHERE status = 'ok') AS ready
			`).get();
		} finally {
			db.close();
		}
	} catch {
		// база занята, побита или ещё не заведена — сказать про неё нечего
		return null;
	}
}

/**
 * Слить журнал в саму базу. Без этого копировать файл базы бессмысленно: в WAL
 * может лежать больше, чем в ней самой (здесь бывало 190 МБ журнала на 115 МБ
 * базы), и уехавшая на полку копия недосчиталась бы работы за несколько дней.
 *
 * Возвращает false, если базу держит кто-то ещё: тогда трогать её нельзя вовсе.
 */
function checkpoint() {
	if (!fs.existsSync(dbPath)) {
		return true;
	}

	try {
		const db = new DatabaseSync(dbPath);

		try {
			const row = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
			return !row || row.busy === 0;
		} finally {
			db.close();
		}
	} catch {
		return false;
	}
}

/**
 * Копия базы одним куском. Делается средствами самой SQLite (VACUUM INTO), а не
 * копированием файла: копия получается согласованной, даже если в базу в этот
 * миг пишут, и заодно ужатой — свободные страницы в неё не попадают.
 */
function snapshot(target) {
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.rmSync(target, { force: true });

	const db = new DatabaseSync(dbPath);

	try {
		db.exec(`VACUUM INTO '${sqlPath(target)}'`);
	} finally {
		db.close();
	}
}

/**
 * Свёрток делается tar — он есть и в Windows 10+, и на машине Actions.
 *
 * База кладётся не та, что лежит в data, а её снимок из STAGE: см. snapshot.
 * Отсюда и два «-C»: сначала переходим в STAGE за базой, потом обратно в корень
 * за обложками. Пути внутри свёртка от этого не меняются — как были «data/…»,
 * так и остались, и разворачивается он у себя в корне проекта.
 *
 * Обложек может не быть (ни один пак ещё не разобран) — тогда в свёрток едет
 * одна база: tar отказался бы целиком из-за одной отсутствующей части.
 */
function pack(file) {
	if (!fs.existsSync(dbPath)) {
		console.error('Складывать нечего: базы нет. Соберите её обычным запуском (npm run index).');
		process.exit(1);
	}

	const stage = path.join(root, STAGE);
	fs.rmSync(stage, { recursive: true, force: true });

	console.log('Снимаю копию базы…');
	snapshot(path.join(stage, 'data', 'sibase.db'));

	/** Что обязано оказаться внутри — этим же списком свёрток потом и проверяется. */
	const parts = ['data/sibase.db'];
	const args = ['-czf', file, '-C', STAGE, 'data/sibase.db'];

	if (fs.existsSync(thumbsPath)) {
		parts.push('data/thumbs');
		args.push('-C', '../..', 'data/thumbs');
	}

	const result = run('tar', args);
	fs.rmSync(stage, { recursive: true, force: true });

	if (result.code !== 0) {
		console.error('Не вышло сложить свёрток.');
		process.exit(1);
	}

	// Заглянуть в собранное перед отправкой. Два «-C» подряд разные tar считают
	// одинаково — второй путь относительно первого, — но проверено это на одной
	// машине, а укладывает свёрток и Windows, и Actions. Ошибись он молча, полка
	// осталась бы без обложек, и заметилось бы это через неделю.
	//
	// Строки режутся по \r\n, а не по \n, нарочно. Windows-овский tar (bsdtar
	// из System32) заканчивает каждую строку списка возвратом каретки, и «data/sibase.db\r»
	// не равно «data/sibase.db» — проверка не находила в свёртке ровно то, что
	// сама же туда только что положила, и всякая выкладка с домашней машины
	// заканчивалась «в свёрток не попало». Под Git Bash тот же код работал:
	// там первым в PATH стоит GNU tar, а он переводит строку по-своему.
	const listed = run('tar', ['-tzf', file], { quiet: true }).out.split(/\r?\n/).map(name => name.trim());

	for (const part of parts) {
		if (!listed.some(name => name === part || name.startsWith(`${part}/`))) {
			console.error(`В свёрток не попало: ${part}. Отправлять такое нельзя.`);
			process.exit(1);
		}
	}
}

/**
 * Развернуть скачанный свёрток на место здешней базы.
 *
 * Порядок здесь важнее, чем кажется. Сначала журнал сливается в базу — иначе
 * отодвинутая копия окажется без последней работы. Потом база отодвигается,
 * а не затирается: разошлись — значит, здесь было что-то своё, и выбрасывать
 * его молча нельзя. И только потом убираются -wal и -shm: оставь их рядом
 * с приехавшей базой — SQLite попыталась бы доиграть в неё чужой журнал.
 */
function unpack() {
	if (fs.existsSync(dbPath) && !checkpoint()) {
		console.error('База занята другой программой — скорее всего, сайт уже запущен.');
		console.error('Закройте окно сайта и повторите: подменять базу под работающим сервером нельзя.');
		process.exit(1);
	}

	if (fs.existsSync(dbPath)) {
		fs.rmSync(prevPath, { force: true });

		try {
			fs.renameSync(dbPath, prevPath);
		} catch {
			console.error('Не вышло отодвинуть здешнюю базу: её кто-то держит открытой.');
			console.error('Закройте сайт (и окно обновления базы) и повторите.');
			process.exit(1);
		}
	}

	for (const suffix of ['-wal', '-shm']) {
		fs.rmSync(`${dbPath}${suffix}`, { force: true });
	}

	if (run('tar', ['-xzf', WORK]).code !== 0) {
		console.error('Не вышло развернуть свёрток. Прежняя база цела: data/sibase.prev.db');
		process.exit(1);
	}
}

const columnsOf = (db, schema, table) =>
	db.prepare('SELECT name FROM pragma_table_info(?, ?)').all(table, schema).map(row => row.name);

/**
 * Один и тот же ли это пак в двух базах.
 *
 * По source_key, а не по номеру строки, и это важно. Номер раздаёт AUTOINCREMENT
 * той базы, в которой пак завели, — то есть той машины, которая нашла его первой.
 * Обе машины ведут счёт от общей полки, но находят новое порознь, и стоит им
 * найти разное, как один и тот же номер окажется у разных паков. Разметку тогда
 * перенесло бы не туда, и заметить это было бы нечем.
 *
 * source_key — это документ ВК («doc-133214983_438981105»), то есть сам файл.
 * По нему пак узнаёт и индексатор (см. knownDocument в src/indexer.js), и он же
 * во всей базе неповторим.
 */
const SAME_PACK = 'src.packages.source_key = main.packages.source_key';

/**
 * Вернуть на место то, что принадлежит этой машине: входы, отметки, оценки
 * (см. PERSONAL). Приехавшая база везёт их слепком с прошлого раза, и без этого
 * шага каждая сверка выкидывала бы из-под пользователя его же вход.
 *
 * Строки, ссылающиеся на паки, которых в новой базе нет, отсеиваются: пак могли
 * убрать из обсуждения, и отметка «сыграно» на пустом месте не нужна никому.
 */
function carryPersonal() {
	if (!fs.existsSync(prevPath)) {
		return;
	}

	const db = new DatabaseSync(dbPath);

	try {
		db.exec(`ATTACH '${sqlPath(prevPath)}' AS prev`);

		for (const table of PERSONAL) {
			const here = columnsOf(db, 'main', table);
			const there = columnsOf(db, 'prev', table);
			const shared = here.filter(column => there.includes(column));

			if (shared.length === 0) {
				continue;
			}

			const list = shared.map(column => `"${column}"`).join(', ');
			const filter = shared.includes('package_id')
				? ' WHERE package_id IN (SELECT id FROM main.packages)'
				: '';

			db.exec('BEGIN');
			db.exec(`DELETE FROM main."${table}"`);
			db.exec(`INSERT OR IGNORE INTO main."${table}" (${list}) SELECT ${list} FROM prev."${table}"${filter}`);
			db.exec('COMMIT');
		}

		db.exec('DETACH prev');
	} catch (error) {
		console.error(`Не вышло перенести здешние отметки и входы: ${error.message}`);
		console.error('База при этом целая — просто вход придётся повторить.');
	} finally {
		db.close();
	}
}

/**
 * Перенести в базу-приёмник ту разметку из базы-источника, которая там свежее
 * (см. MARKUP). Работает в обе стороны и обе стороны зовут её одинаково:
 * при подмене базы источник — отодвинутая здешняя, приёмник — приехавшая
 * с полки; при отправке наоборот.
 *
 * Сравниваются отметки времени, а не «пусто или нет»: пак, размеченный здесь
 * вчера, не должен затирать разметку, сделанную полкой сегодня. NULL у источника
 * не переносится никогда — это не «свежий пустой ответ», а «не спрашивали».
 *
 * Паки, которых в приёмнике нет, пропускаются молча: разметка без пака никому
 * не нужна, а перенос пака целиком — не дело этой руки.
 *
 * @returns {{name: string, moved: number}[]} что и сколько перенесено
 */
function carryMarkup(from, into) {
	if (!fs.existsSync(from) || !fs.existsSync(into)) {
		return [];
	}

	const db = new DatabaseSync(into);
	const done = [];

	try {
		db.exec(`ATTACH '${sqlPath(from)}' AS src`);

		const here = columnsOf(db, 'main', 'packages');
		const there = columnsOf(db, 'src', 'packages');

		for (const part of MARKUP) {
			// Колонки, которые есть в обеих: базы бывают разного возраста, и та,
			// что постарше, попросту не знает про недавно заведённое.
			const shared = part.columns.filter(column => here.includes(column) && there.includes(column));

			if (!shared.includes(part.at)) {
				continue;
			}

			// Свежее — это строго новее. Равные отметки времени означают одну
			// и ту же работу, приехавшую двумя путями, и трогать её незачем.
			const fresher = `src.packages.${part.at} IS NOT NULL
				AND (main.packages.${part.at} IS NULL OR src.packages.${part.at} > main.packages.${part.at})`;

			const assign = shared.map(column => `"${column}" = (SELECT "${column}" FROM src.packages WHERE ${SAME_PACK})`);

			db.exec('BEGIN');

			db.exec(`
				UPDATE main.packages SET ${assign.join(', ')}
				WHERE EXISTS (SELECT 1 FROM src.packages WHERE ${SAME_PACK} AND ${fresher})
			`);

			const moved = db.prepare('SELECT changes() AS c').get().c;
			db.exec('COMMIT');

			if (moved > 0) {
				done.push({ name: part.name, moved });
			}
		}

		// Расход квоты — тоже общее знание, и терять его нельзя ни в какую сторону.
		// Считает Google по своим суткам и по всему ключу разом, а тратят ключ обе
		// машины; больший расход за день и есть правда о нём. Знай ночь про это,
		// она не потратила бы двадцать минут на запросы, которым заранее отказано.
		db.exec(`
			INSERT INTO main.gemini_usage (day, model, requests, quota_hits)
			SELECT day, model, requests, quota_hits FROM src.gemini_usage
			WHERE true
			ON CONFLICT (day, model) DO UPDATE SET
				requests = MAX(requests, excluded.requests),
				quota_hits = MAX(quota_hits, excluded.quota_hits)
		`);

		// Пределы моделей — то же самое, только свежесть тут по seen_at: это
		// не расход, а то, что Gemini сказал про модель, когда его в последний раз
		// об этом спросили. Колонки перечисляются не списком, а сверкой: unavailable
		// и note заведены позже самой таблицы, и в базе постарше их может не быть.
		const limitColumns = columnsOf(db, 'main', 'gemini_limits')
			.filter(column => columnsOf(db, 'src', 'gemini_limits').includes(column));

		if (limitColumns.includes('model') && limitColumns.includes('seen_at')) {
			const list = limitColumns.map(column => `"${column}"`).join(', ');
			const set = limitColumns.filter(column => column !== 'model')
				.map(column => `"${column}" = excluded."${column}"`).join(', ');

			db.exec(`
				INSERT INTO main.gemini_limits (${list}) SELECT ${list} FROM src.gemini_limits
				WHERE true
				ON CONFLICT (model) DO UPDATE SET ${set}
				WHERE excluded.seen_at > gemini_limits.seen_at
			`);
		}

		db.exec('DETACH src');
	} catch (error) {
		console.error(`Не вышло перенести разметку: ${error.message}`);
		console.error('База при этом целая, но часть разметки могла остаться только в старой копии.');
	} finally {
		db.close();
	}

	return done;
}

/** Одной строкой: что перенеслось. Молчит, когда переносить было нечего. */
function sayCarried(done, where) {
	if (done.length > 0) {
		console.log(`Перенесено ${where}: ${done.map(part => `${part.name} — ${part.moved} паков`).join(', ')}.`);
	}
}

function showStatus() {
	const here = localStamp();
	const there = remoteAsset();
	const mark = readMark();

	console.log(here
		? `Здесь:  ${megabytes(here.size)}, ${when(here.at)}`
		: 'Здесь:  базы нет');

	console.log(there
		? `На полке: ${megabytes(there.size)}, ${when(there.updatedAt)}`
		: `На полке: ничего (отметки «${TAG}» с приложением нет)`);

	if (there && here) {
		console.log(mark && mark.id === assetId(there)
			? 'Сходится: здешняя база — это полка, то есть то же, что на сайте.'
			: 'Разошлось: здешняя база не с этой полки. Подогнать — npm run sync');
	}

	return { here, there, mark };
}

function pull() {
	requireGh();
	const there = remoteAsset();

	if (!there) {
		console.error('На полке ничего нет. Первый свёрток кладётся отсюда: node scripts/state.js push');
		process.exit(1);
	}

	console.log(`Забираю ${megabytes(there.size)} от ${when(there.updatedAt)}…`);

	fs.mkdirSync(path.join(root, 'data'), { recursive: true });
	fs.rmSync(path.join(root, WORK), { force: true });

	if (run('gh', ['release', 'download', TAG, '--pattern', ASSET, '--output', WORK, '--clobber']).code !== 0) {
		console.error('Не вышло скачать.');
		process.exit(1);
	}

	unpack();
	carryPersonal();

	// Разметку, сделанную здесь, приехавшая база не отменяет: у кого свежее,
	// того и ответ (см. MARKUP). Без этой строки всякая сверка выбрасывала бы
	// всё, что здесь размечено с прошлого раза, — молча и целиком.
	sayCarried(carryMarkup(prevPath, dbPath), 'из здешней базы');

	writeMark(there);

	fs.rmSync(path.join(root, WORK), { force: true });

	// Считаем паки в обеих: в отодвинутой прежней и в приехавшей. Прежнюю читаем
	// после подмены нарочно — к этому времени её журнал слит в неё саму, и открыть
	// её на чтение можно чем угодно; до подмены рядом с ней лежал живой WAL.
	const before = contentOf(prevPath);
	const after = contentOf(dbPath);

	if (before && after) {
		console.log(`Было: ${before.ready} разобранных паков из ${before.packs}. `
			+ `Стало: ${after.ready} из ${after.packs}.`);

		// Здешнее оказалось богаче приехавшего — значит, тут работали и наверх это
		// не уехало. Молчать нельзя: файл с прежней базой рядом, но сам о себе
		// он не расскажет, а через день его затрёт следующая сверка.
		if (before.ready > after.ready) {
			console.log('');
			console.log('Внимание: здесь было разобрано больше, чем приехало с полки.');
			console.log(`Прежняя база отодвинута в ${path.relative(root, prevPath)} — она никуда не делась.`);
			console.log('Если наверх надо было увезти именно её, верните файл на место и выложите: npm run deploy');
		}
	}

	console.log('Готово. База и обложки — те же, что на сайте.');
}

/**
 * Забрать с полки одну только базу — во временное место, не трогая здешнюю, —
 * и влить из неё в здешнюю ту разметку, которой здесь нет или которая здесь
 * старее (см. carryMarkup). Нужно перед отправкой, когда полка успела уйти
 * вперёд: то, что мы сейчас положим, не должно стереть чужую работу.
 *
 * Сливается именно разметка, а не всё подряд. Паки, которых здесь нет вовсе,
 * этой рукой не переносятся: перенос строки пака тянет за собой авторов,
 * статистику и отметку о выгрузке, и делать это вслепую опаснее, чем не делать.
 * Пропасть таким паком может только то, что полка нашла в обсуждении за те
 * часы, пока здесь шла работа, — а обсуждение читается заново каждый час,
 * и следующий же обход найдёт его снова.
 */
function mergeShelf() {
	const stage = path.join(root, STAGE);
	fs.rmSync(stage, { recursive: true, force: true });
	fs.rmSync(path.join(root, WORK), { force: true });

	try {
		if (run('gh', ['release', 'download', TAG, '--pattern', ASSET, '--output', WORK, '--clobber']).code !== 0) {
			console.error('Не вышло скачать полку для слияния. Отправка отменена: лучше ничего, чем поверх чужого.');
			process.exit(1);
		}

		fs.mkdirSync(stage, { recursive: true });

		// Только база: обложки полки здешним не мешают и сливать их незачем —
		// они и так складываются, а не подменяются (разворачивается свёрток
		// поверх, ничего не удаляя).
		if (run('tar', ['-xzf', WORK, '-C', STAGE, 'data/sibase.db']).code !== 0) {
			console.error('Не вышло развернуть полку для слияния. Отправка отменена.');
			process.exit(1);
		}

		const shelfDb = path.join(stage, 'data', 'sibase.db');
		sayCarried(carryMarkup(shelfDb, dbPath), 'с полки');

		const mine = contentOf(dbPath);
		const theirs = contentOf(shelfDb);

		// Паки, которых здесь нет: сказать о них надо, а перенести — не этой рукой.
		// Молчать нельзя, потому что после отправки они с полки пропадут до тех пор,
		// пока обход не найдёт их в обсуждении заново.
		if (mine && theirs && theirs.packs > mine.packs) {
			console.log(`Внимание: на полке паков больше (${theirs.packs} против ${mine.packs}).`);
			console.log('Разметка их перенесена, сами строки — нет: их подберёт ближайший обход обсуждений.');
		}
	} finally {
		fs.rmSync(stage, { recursive: true, force: true });
		fs.rmSync(path.join(root, WORK), { force: true });
	}
}

function push() {
	const here = localStamp();

	if (!here) {
		console.error('Базы нет: класть на полку нечего.');
		process.exit(1);
	}

	requireGh();
	const there = remoteAsset();
	const mark = readMark();

	// Полка сменилась с тех пор, как здешняя база с неё приехала: пока здесь
	// работали, ежечасный или ночной обход сложил туда своё. Отправить наше как
	// есть — значит стереть это чужое; отказаться — значит потерять своё, потому
	// что здешнее рано или поздно перетрёт ближайшая сверка. Оба исхода были
	// в живую (см. MARKUP), поэтому здесь теперь не отказ, а слияние.
	const moved = Boolean(there) && (mark
		? mark.id !== assetId(there)
		// Отметки нет вовсе (первый раз, чужая машина, руками положенная база) —
		// судим по старинке, по времени файла.
		: here.at < new Date(there.updatedAt));

	if (moved && force) {
		console.log(`Полка ушла вперёд (свёрток от ${when(there.updatedAt)}), но велено затереть её как есть.`);
	} else if (moved) {
		console.log(`Полка ушла вперёд (свёрток от ${when(there.updatedAt)}). Сливаю с ней здешнее…`);
		mergeShelf();
	}

	console.log('Складываю свёрток…');
	pack(WORK);

	const file = path.join(root, WORK);
	console.log(`Свёрток: ${megabytes(fs.statSync(file).size)}. Отправляю…`);

	// Отметки может ещё не быть — заводим. Черновик нарочно: это не выпуск
	// программы, а служебная полка, и в списке релизов ей делать нечего.
	if (!there && run('gh', ['release', 'view', TAG], { quiet: true }).code !== 0) {
		run('gh', ['release', 'create', TAG,
			'--title', 'Рабочее состояние базы',
			'--notes', 'Свёрток с базой и обложками для ночного обхода. Собирается scripts/state.js, руками сюда ничего класть не надо.',
			'--latest=false',
		]);
	}

	if (run('gh', ['release', 'upload', TAG, WORK, '--clobber']).code !== 0) {
		console.error('Не вышло отправить.');
		process.exit(1);
	}

	fs.rmSync(file, { force: true });

	// Что уехало — то теперь и лежит на полке, и здешняя база помечается им же:
	// иначе следующая сверка сочла бы полку чужой и забрала бы обратно то самое,
	// что мы только что отсюда отправили.
	const uploaded = remoteAsset();

	if (uploaded) {
		writeMark(uploaded);
	}

	console.log('Готово.');
}

/**
 * Сверка перед запуском сайта: здешняя база должна быть тем же, что на сайте.
 *
 * Правило одно и простое: сменилась полка — забираем полку. Всё остальное здесь
 * ради того, чтобы сверка никогда не мешала запуску. Нет gh, нет сети, пуста
 * полка — говорим об этом одной строкой и запускаемся на том, что есть: сайт
 * со вчерашней базой лучше, чем не открывшийся сайт.
 */
function sync() {
	if (!haveGh()) {
		console.log('Сверить базу с сайтом нечем: не установлен gh (winget install GitHub.cli).');
		console.log('Запускаюсь на здешней базе.');
		return;
	}

	const there = remoteAsset();

	if (!there) {
		console.log('Полка пуста или до GitHub не достучаться — запускаюсь на здешней базе.');
		return;
	}

	const mark = readMark();

	if (mark && mark.id === assetId(there) && fs.existsSync(dbPath)) {
		console.log(`База та же, что на сайте (полка от ${when(there.updatedAt)}).`);
		return;
	}

	console.log(fs.existsSync(dbPath)
		? 'База разошлась с сайтом — забираю с полки.'
		: 'Базы здесь нет — забираю с полки.');

	pull();
}

/**
 * Влить разметку из другой копии базы в здешнюю: `node scripts/state.js merge <файл>`.
 *
 * Рука, которой чинят уже случившееся. Обычно перенос идёт сам — при сверке
 * и при отправке на полку, — но копия с потерянной работой может лежать где
 * угодно: в data/sibase.prev.db (туда её отодвигает сверка), в старом свёртке,
 * на другой машине. Отсюда отдельная команда: скажи, откуда взять, — возьмёт.
 *
 * Правило то же самое, что и везде: переносится только то, что в названной
 * копии свежее здешнего. Испортить здешнюю разметку этим нельзя.
 */
function merge(file) {
	if (!file) {
		console.error('Скажите, из какой копии вливать: node scripts/state.js merge data/sibase.prev.db');
		process.exit(1);
	}

	const from = path.resolve(root, file);

	if (!fs.existsSync(from)) {
		console.error(`Нет такого файла: ${from}`);
		process.exit(1);
	}

	if (!fs.existsSync(dbPath)) {
		console.error('Здешней базы нет — вливать не во что.');
		process.exit(1);
	}

	const before = contentOf(dbPath);
	const done = carryMarkup(from, dbPath);

	if (done.length === 0) {
		console.log(`В ${path.relative(root, from)} нет разметки свежее здешней. Ничего не менял.`);
		return;
	}

	sayCarried(done, `из ${path.relative(root, from)}`);

	const after = contentOf(dbPath);

	if (before && after) {
		console.log(`Разобранных паков: было ${before.ready}, стало ${after.ready} (перенос их не трогает).`);
	}

	console.log('');
	console.log('Дальше это надо увезти наверх, иначе оно так и останется только здесь:');
	console.log('  npm run deploy');
}

if (command === 'status') {
	requireGh();
	showStatus();
} else if (command === 'sync') {
	sync();
} else if (command === 'pull') {
	pull();
} else if (command === 'push') {
	push();
} else if (command === 'merge') {
	merge(process.argv[3]);
} else {
	console.error(`Не знаю команды «${command}». Есть status, sync, pull, push и merge.`);
	process.exit(1);
}
