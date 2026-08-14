// Запуск сайта на этом компьютере: сначала сверить базу с сайтом, потом открыть.
//
// Зачем понадобилась отдельная дверь вместо `node src/server.js`. Паки собирает
// ночной обход в облаке, а здешняя база — его копия (см. scripts/state.js).
// Копия отстаёт от полки на все ночи, что сайт не запускали, и запуск «как есть»
// показывал бы дома одно, а на firepacks.longld342.workers.dev — другое.
// Поэтому запуск начинается со сверки: полка сменилась — забираем полку.
//
// Сверка идёт до того, как база кому-нибудь открыта, и это единственный миг,
// когда её вообще можно подменить: сервер держит базу открытой сутками, а Windows
// не даёт переименовать открытый файл. Отсюда и порядок — сверка, потом сервер
// в этом же процессе, обычным import.
//
// Ключи: --no-sync  — не сверяться, запуститься на здешней базе (пригодится,
//                     когда GitHub лежит, а сайт нужен сейчас);
//        --open     — открыть окно браузера, когда сервер поднялся; так делают
//                     ярлыки «Запустить сайт» и «Обновить базу»;
//        --page=…   — какую страницу открыть (по умолчанию главную).
//
// Всё остальное уходит серверу как есть.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const skipSync = process.argv.includes('--no-sync') || process.env.FIREPACKS_NO_SYNC === '1';
const open = process.argv.includes('--open');
const page = (process.argv.find(argument => argument.startsWith('--page=')) ?? '--page=/').slice('--page='.length);

if (!skipSync) {
	console.log('───── Сверка базы с сайтом ─────');

	// Отдельным процессом, а не import: сверка открывает базу, чтобы слить журнал
	// и перенести здешние отметки, и все эти соединения должны быть закрыты
	// до того, как базу откроет сервер. Кончился процесс — кончились и они.
	spawnSync(process.execPath, ['--no-warnings', path.join(root, 'scripts', 'state.js'), 'sync'], {
		cwd: root,
		stdio: 'inherit',
	});

	console.log('');
}

if (open) {
	// Ждать нечего: сервер поднимается за доли секунды, а браузер открывает
	// вкладку дольше, чем это занимает. Запускается через оболочку — своей
	// команды «открой ссылку» у Node нет, и у каждой системы она своя.
	const { port } = await import('../src/config.js').then(module => module.config);
	const url = `http://localhost:${port}${page}`;

	const [command, args] = process.platform === 'win32'
		? ['cmd', ['/c', 'start', '', url]]
		: [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];

	try {
		spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
	} catch {
		console.log(`Откройте в браузере: ${url}`);
	}
}

await import('../src/server.js');
