// Выкладка сайта на Cloudflare одной командой.
//
// По порядку: собрать статику, выгрузить базу, залить схему (она создаётся
// только в первый раз), залить паки, выложить Worker. Всё это можно делать
// и вручную — здесь просто перечислено, что за чем, чтобы не забыть половину.
//
// Ключи: --local  — залить в местную базу для проверки (npm run cf:dev),
//                   Worker при этом не выкладывается;
//        --db-only — только база, без выкладки Worker;
//        --full    — залить базу целиком, а не только изменившееся.
//
// Наверх обычно уезжают только те строки, которые с прошлого раза изменились
// (см. scripts/export-d1.js). Отметка «доехало» ставится здесь и только после
// того, как последний кусок SQL действительно выполнился: сорвавшаяся на середине
// выкладка не должна оставить базу в уверенности, что наверху лежит то, чего
// там нет. Следующий запуск тогда просто отправит те же строки заново.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataPath = path.join(root, 'cf', 'data');

const local = process.argv.includes('--local');
const dbOnly = process.argv.includes('--db-only');

/**
 * Местная копия — всегда целиком и без отметки «доехало». Она живёт в .wrangler
 * рядом с проектом и к настоящей базе в Cloudflare отношения не имеет: запомнить
 * по ней, что там уже лежит, значило бы соврать самим себе, и следующая настоящая
 * выкладка недосчиталась бы всего, что проверялось на местной.
 */
const whole = local || process.argv.includes('--full');

const DB_NAME = 'firepacks';

function run(command, args) {
	console.log(`\n$ ${command} ${args.join(' ')}`);

	const result = spawnSync(command, args, {
		cwd: root,
		stdio: 'inherit',
		shell: process.platform === 'win32',
	});

	if (result.status !== 0) {
		console.error(`\nСорвалось на: ${command} ${args.join(' ')}`);
		process.exit(result.status ?? 1);
	}
}

/** Заливка файла SQL. Куда — решает --local: в местную копию или в настоящую базу. */
function execute(file) {
	run('npx', ['wrangler', 'd1', 'execute', DB_NAME, local ? '--local' : '--remote', `--file=${file}`, '-y']);
}

/**
 * Ключи Discord для местной проверки. Наверху они лежат в секретах Cloudflare,
 * а `wrangler dev` их оттуда не видит и читает файл .dev.vars — поэтому при
 * проверке он собирается из тех же data/discord-*.txt, которыми пользуется
 * домашний сайт.
 *
 * Без него вход на местной копии не работает вовсе: сайт, не видя ключей,
 * даже не спрашивает, кто пришёл, — и проверить оценки с отметками нечем.
 * Файл переписывается каждой проверкой и в облако не уезжает никогда.
 */
function writeDevVars() {
	const read = name => {
		try {
			return fs.readFileSync(path.join(root, 'data', name), 'utf8').trim();
		} catch {
			return '';
		}
	};

	const id = read('discord-client-id.txt');
	const secret = read('discord-client-secret.txt');

	if (!id || !secret) {
		console.log('Ключей Discord в data нет — вход на местной копии работать не будет.');
		return;
	}

	fs.writeFileSync(
		path.join(root, '.dev.vars'),
		`# Собрано scripts/deploy-cf.js для местной проверки. Наверху эти ключи живут\n`
		+ `# в секретах Cloudflare (npx wrangler secret put), а не в файлах.\n`
		+ `DISCORD_CLIENT_ID=${id}\nDISCORD_CLIENT_SECRET=${secret}\n`,
		'utf8',
	);

	console.log('Ключи Discord для местной проверки записаны в .dev.vars');
}

function main() {
	if (!local) {
		const config = fs.readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8');

		if (config.includes('поставит-npm-run-cf-setup')) {
			console.error('Сначала заведите базу в Cloudflare: npm run cf:setup');
			process.exit(1);
		}
	}

	console.log('\n───── Статика ─────');
	run('node', ['--no-warnings', 'scripts/build-web.js']);

	console.log('\n───── Выгрузка базы ─────');
	run('node', ['--no-warnings', 'scripts/export-d1.js', ...(whole ? ['--full'] : [])]);

	// Схема прогоняется каждый раз, но делает что-то только в первый: таблицы
	// с оценками и входами создаются с IF NOT EXISTS и потом не трогаются.
	// Заливка паков их не касается вовсе — иначе выкладка стирала бы всё,
	// что накопили посетители (см. cf/schema.sql).
	console.log('\n───── Таблицы посетителей ─────');
	execute('cf/schema.sql');

	console.log('\n───── Паки ─────');

	for (const name of fs.readdirSync(dataPath).sort()) {
		execute(path.join('cf', 'data', name));
	}

	if (local) {
		writeDevVars();
		console.log('\nМестная копия готова. Дальше: npx wrangler dev');
		return;
	}

	// Всё доехало — можно запомнить, что именно
	run('node', ['--no-warnings', 'scripts/export-d1.js', '--commit']);

	if (dbOnly) {
		console.log('\nБаза залита. Сам сайт не трогали.');
		return;
	}

	console.log('\n───── Выкладка ─────');
	run('npx', ['wrangler', 'deploy']);

	console.log('\nГотово.');
}

main();
