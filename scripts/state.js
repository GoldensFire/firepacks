// Рабочее состояние базы: как оно ездит между этим компьютером и GitHub.
//
//   node scripts/state.js status   что лежит на полке и что здесь
//   node scripts/state.js sync     подогнать здешнее под полку (это делает запуск сайта)
//   node scripts/state.js pull     забрать полку к себе
//   node scripts/state.js push     отдать своё на полку
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
	const listed = run('tar', ['-tzf', file], { quiet: true }).out.split('\n');

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

function push() {
	const here = localStamp();

	if (!here) {
		console.error('Базы нет: класть на полку нечего.');
		process.exit(1);
	}

	requireGh();
	const there = remoteAsset();
	const mark = readMark();

	// Полка сменилась с тех пор, как здешняя база с неё приехала: ночной обход
	// уже сложил туда свою работу, и наша копия её не содержит. Затирать такое
	// нельзя — это ровно тот случай, когда пропадает целая ночь разбора.
	if (there && mark && mark.id !== assetId(there) && !force) {
		console.error(`На полке уже не тот свёрток, с которого сюда приехала база (полка от ${when(there.updatedAt)}).`);
		console.error('Сначала заберите её: npm run sync. Затирать полку — только с --force.');
		process.exit(1);
	}

	// Отметки нет вовсе (первый раз, чужая машина, руками положенная база) —
	// тогда судим по старинке, по времени файла: своё старее полки означает,
	// что где-то её уже дополнили, а здесь лежит копия до этого.
	if (there && !mark && here.at < new Date(there.updatedAt) && !force) {
		console.error(`На полке база новее здешней (${when(there.updatedAt)} против ${when(here.at)}).`);
		console.error('Сначала заберите её: npm run sync. Затирать полку — только с --force.');
		process.exit(1);
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

if (command === 'status') {
	requireGh();
	showStatus();
} else if (command === 'sync') {
	sync();
} else if (command === 'pull') {
	pull();
} else if (command === 'push') {
	push();
} else {
	console.error(`Не знаю команды «${command}». Есть status, sync, pull и push.`);
	process.exit(1);
}
