// Ночной обход базы: собрать всё новое и выложить наверх. Одна команда,
// которую запускает расписание, — `npm run nightly`.
//
// Почему это отдельный файл, а не строчка в планировщике. Шагов два, и второй
// имеет смысл только после первого: сначала индексатор дополняет домашнюю базу
// (ВК, разбор паков, статистика, Gemini), потом выкладка увозит её в Cloudflare.
// Записанные в планировщик две команды подряд выполнились бы обе, даже если
// первая упала, — и наверх уехала бы недособранная база. Здесь же падение
// индексатора отменяет выкладку.
//
// Второе, ради чего это здесь: след. Ночной запуск некому смотреть, и без записи
// «прошло за 40 минут, добавлено 12 паков» о том, что расписание вообще работает,
// узнать неоткуда. Каждый запуск пишет свой файл в data/nightly, а сама папка
// подчищается: тридцати последних ночей хватает, чтобы понять, когда сломалось.
//
// Ключи: --no-deploy — только собрать базу дома, наверх не выкладывать.
//
// Всё остальное уходит индексатору как есть, поэтому ночь можно сделать легче,
// чем полный проход: `npm run nightly -- --steps=stats,recalc` обновит только
// статистику и уровни, не трогая ни ВК, ни Gemini.
//
// Кто это запускает — дело десятое, и оба способа зовут одну и ту же команду:
//   дома   — задание Windows, его заводит scripts/schedule-nightly.ps1
//            (он же считает, во сколько по местным часам наступает час ночи
//            по Москве);
//   в облаке — GitHub Actions, .github/workflows/nightly.yml. Там перед этим
//            приезжает база, а после — уезжает обратно (см. scripts/state.js).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const logsPath = path.join(root, 'data', 'nightly');

/** Сколько последних отчётов держим. */
const KEEP_LOGS = 30;

const deploy = !process.argv.includes('--no-deploy');

/** Свой ключ здесь один; остальные — не наше дело, они для индексатора. */
const indexerArgs = process.argv.slice(2).filter(arg => arg !== '--no-deploy');

fs.mkdirSync(logsPath, { recursive: true });

const startedAt = new Date();
const stamp = startedAt.toISOString().slice(0, 19).replace(/[:T]/g, '-');
const logFile = path.join(logsPath, `${stamp}.log`);
const log = fs.createWriteStream(logFile, { flags: 'a' });

/** В файл — всегда, в окно — тоже: запуск руками должен что-то показывать. */
function say(line) {
	const text = `[${new Date().toLocaleTimeString('ru-RU')}] ${line}`;
	console.log(text);
	log.write(`${text}\n`);
}

/**
 * Запуск команды с записью всего, что она напечатала. Вывод индексатора идёт
 * в файл как есть, без отметок времени: там своя разметка ходов, и подпись
 * перед каждой строкой сделала бы её нечитаемой.
 */
function run(command, args) {
	return new Promise(resolve => {
		say(`$ ${command} ${args.join(' ')}`);

		// Без оболочки нарочно. Node у большинства стоит в «C:\Program Files\nodejs»,
		// а оболочка Windows разбирает строку по пробелам сама и находит там
		// несуществующую программу «C:\Program». Запускать здесь нечего, кроме
		// самого Node, — оболочка не нужна вовсе, и без неё пробелы не мешают.
		const child = spawn(command, args, {
			cwd: root,
			// Индексатор печатает отчёт о ходе работы отдельной разметкой — она нужна
			// странице обновления, а в файле только мусорит. Здесь её нет: переменная
			// FIREPACKS_GUI не ставится, и он пишет обычными словами.
			env: { ...process.env },
		});

		child.stdout.on('data', chunk => log.write(chunk));
		child.stderr.on('data', chunk => log.write(chunk));

		child.on('error', error => {
			say(`не вышло запустить: ${error.message}`);
			resolve(1);
		});

		child.on('close', code => resolve(code ?? 1));
	});
}

/** Старые отчёты. Держать их все незачем: за год набежит триста файлов. */
function trimLogs() {
	const files = fs.readdirSync(logsPath).filter(name => name.endsWith('.log')).sort();

	for (const name of files.slice(0, Math.max(0, files.length - KEEP_LOGS))) {
		fs.rmSync(path.join(logsPath, name), { force: true });
	}
}

const minutes = () => ((Date.now() - startedAt.getTime()) / 60000).toFixed(1);

say(`Ночной обход базы начат. Отчёт: ${logFile}`);

// Сверка с полкой — то же самое, что делает запуск сайта (см. scripts/state.js).
// Дополнять вчерашнюю копию нельзя: работа ляжет поверх устаревшего, а потом
// уедет на полку и затрёт там свежее. В Actions базу привозит отдельный шаг
// самого workflow, и второй раз её тянуть незачем.
if (!process.env.GITHUB_ACTIONS) {
	await run(process.execPath, ['--no-warnings', 'scripts/state.js', 'sync']);
}

// Индексатор без ключей делает обычный полный проход: ВК, разбор новых паков,
// статистика, тематики и краткие описания (см. STEPS в src/indexer.js).
const indexed = await run(process.execPath, ['--no-warnings', 'src/indexer.js', ...indexerArgs]);

if (indexed !== 0) {
	say(`Индексатор завершился с кодом ${indexed}. Наверх ничего не выкладываем: `
		+ 'недособранная база хуже вчерашней, которая там уже лежит.');
	trimLogs();
	log.end();
	process.exit(indexed);
}

say(`База собрана за ${minutes()} мин.`);

if (!deploy) {
	say('Выкладка отключена ключом --no-deploy. Готово.');
	trimLogs();
	log.end();
	process.exit(0);
}

const deployed = await run(process.execPath, ['--no-warnings', 'scripts/deploy-cf.js']);

if (deployed !== 0) {
	say(`Выкладка сорвалась с кодом ${deployed}. Дома база при этом собрана и цела: `
		+ 'её можно увезти наверх вручную командой npm run deploy.');
	trimLogs();
	log.end();
	process.exit(deployed);
}

say(`Готово. Всё вместе заняло ${minutes()} мин.`);
trimLogs();
log.end();
