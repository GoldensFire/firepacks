// Рабочее состояние базы: как оно ездит между этим компьютером и GitHub.
//
//   node scripts/state.js status   что лежит наверху и что здесь
//   node scripts/state.js pull     забрать наверхнее к себе
//   node scripts/state.js push     отдать своё наверх
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

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Отметка релиза, к которой прикладывается состояние. Одна на всё время. */
const TAG = 'state';

/** Имя приложения. Оно же — имя файла, который скачивается при pull. */
const ASSET = 'firepacks-state.tgz';

/** Что кладём в свёрток. Пути от корня проекта: tar разворачивает их как есть. */
const PARTS = ['data/sibase.db', 'data/thumbs'];

const command = process.argv[2] ?? 'status';
const force = process.argv.includes('--force');

/**
 * Запуск с выводом наружу. Возвращает код, а не падает: у каждой команды здесь
 * своя реакция на неудачу, и общее «умереть» ни одной не подходит.
 */
function run(program, args, options = {}) {
	const result = spawnSync(program, args, {
		cwd: root,
		stdio: options.quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
		shell: process.platform === 'win32',
		encoding: 'utf8',
	});

	return { code: result.status ?? 1, out: (result.stdout ?? '').trim(), err: (result.stderr ?? '').trim() };
}

function requireGh() {
	if (run('gh', ['--version'], { quiet: true }).code !== 0) {
		console.error('Нет gh — это команда GitHub. Поставьте её (winget install GitHub.cli) и войдите: gh auth login');
		process.exit(1);
	}
}

/** Что лежит наверху: время и размер приложения. null — там ещё ничего нет. */
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

const dbPath = path.join(root, 'data', 'sibase.db');

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

function showStatus() {
	const here = localStamp();
	const there = remoteAsset();

	console.log(here
		? `Здесь:  ${megabytes(here.size)}, ${when(here.at)}`
		: 'Здесь:  базы нет');

	console.log(there
		? `Наверху: ${megabytes(there.size)}, ${when(there.updatedAt)}`
		: `Наверху: ничего (отметки «${TAG}» с приложением нет)`);

	return { here, there };
}

/**
 * Свёрток делается tar — он есть и в Windows 10+, и на машине Actions.
 * Папки может не быть (обложки ещё не собирались) — такие части просто
 * пропускаем, иначе tar откажется целиком из-за одной отсутствующей.
 */
function pack(file) {
	const parts = PARTS.filter(part => fs.existsSync(path.join(root, part)));

	if (parts.length === 0) {
		console.error('Складывать нечего: базы нет. Соберите её обычным запуском (npm run index).');
		process.exit(1);
	}

	const result = run('tar', ['-czf', file, ...parts]);

	if (result.code !== 0) {
		console.error('Не вышло сложить свёрток.');
		process.exit(1);
	}
}

function pull() {
	requireGh();
	const there = remoteAsset();

	if (!there) {
		console.error(`Наверху ничего нет. Первый свёрток кладётся отсюда: node scripts/state.js push`);
		process.exit(1);
	}

	const here = localStamp();

	// Своё, которое новее наверхнего, молча затирать нельзя: это ровно тот случай,
	// когда дома только что разобрали двенадцать тысяч паков, а сверху приедет
	// вчерашняя база и всё это перепишет.
	if (here && here.at > new Date(there.updatedAt) && !force) {
		console.error(`Здешняя база новее наверхней (${when(here.at)} против ${when(there.updatedAt)}).`);
		console.error('Если наверхнюю всё равно надо забрать — добавьте --force.');
		process.exit(1);
	}

	const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'firepacks-'));
	const file = path.join(temporary, ASSET);

	console.log(`Забираю ${megabytes(there.size)} от ${when(there.updatedAt)}…`);

	if (run('gh', ['release', 'download', TAG, '--pattern', ASSET, '--dir', temporary, '--clobber']).code !== 0) {
		console.error('Не вышло скачать.');
		process.exit(1);
	}

	if (run('tar', ['-xzf', file]).code !== 0) {
		console.error('Не вышло развернуть свёрток.');
		process.exit(1);
	}

	fs.rmSync(temporary, { recursive: true, force: true });
	console.log('Готово. База и обложки на месте.');
}

function push() {
	requireGh();

	const here = localStamp();

	if (!here) {
		console.error('Базы нет: класть наверх нечего.');
		process.exit(1);
	}

	const there = remoteAsset();

	// Обратная защита: своё старее наверхнего означает, что где-то (скорее всего
	// ночью в Actions) базу уже дополнили, а здесь лежит копия до этого.
	if (there && here.at < new Date(there.updatedAt) && !force) {
		console.error(`Наверху база новее здешней (${when(there.updatedAt)} против ${when(here.at)}).`);
		console.error('Сначала заберите её: node scripts/state.js pull. Затирать наверхнюю — только с --force.');
		process.exit(1);
	}

	const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'firepacks-'));
	const file = path.join(temporary, ASSET);

	console.log('Складываю свёрток…');
	pack(file);
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

	if (run('gh', ['release', 'upload', TAG, file, '--clobber']).code !== 0) {
		console.error('Не вышло отправить.');
		process.exit(1);
	}

	fs.rmSync(temporary, { recursive: true, force: true });
	console.log('Готово.');
}

if (command === 'status') {
	requireGh();
	showStatus();
} else if (command === 'pull') {
	pull();
} else if (command === 'push') {
	push();
} else {
	console.error(`Не знаю команды «${command}». Есть status, pull и push.`);
	process.exit(1);
}
