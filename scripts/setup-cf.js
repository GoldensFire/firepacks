// Первичная настройка Cloudflare. Запускается один раз: заводит базу D1,
// вписывает её номер в wrangler.jsonc и, если ключи Discord лежат в data,
// перекладывает их в секреты Cloudflare.
//
// Всё, что делает этот файл, можно сделать и руками — он просто избавляет
// от переписывания длинного номера базы из вывода одной команды в конфиг.
// Что именно он делает, он говорит вслух: команда печатается перед запуском.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.join(root, 'wrangler.jsonc');
const dataPath = path.join(root, 'data');

const DB_NAME = 'firepacks';

/** Заглушка, которая стоит в конфиге до первой настройки. */
const PLACEHOLDER = 'поставит-npm-run-cf-setup';

function wrangler(args, options = {}) {
	console.log(`\n$ npx wrangler ${args.join(' ')}`);

	return spawnSync('npx', ['wrangler', ...args], {
		cwd: root,
		encoding: 'utf8',
		shell: process.platform === 'win32',
		...options,
	});
}

/**
 * Номер уже заведённой базы. Спрашиваем прежде, чем заводить: повторный запуск
 * настройки не должен плодить вторую базу с тем же именем и уводить сайт
 * на пустую.
 */
function existingDatabaseId() {
	const result = wrangler(['d1', 'info', DB_NAME, '--json']);

	if (result.status !== 0) {
		return null;
	}

	try {
		return JSON.parse(result.stdout).uuid ?? null;
	} catch {
		return null;
	}
}

function createDatabase() {
	const result = wrangler(['d1', 'create', DB_NAME]);
	process.stdout.write(result.stdout ?? '');
	process.stderr.write(result.stderr ?? '');

	if (result.status !== 0) {
		return null;
	}

	// wrangler печатает готовый кусок конфига; номер из него и берём
	const found = /["']?database_id["']?\s*[:=]\s*["']([0-9a-f-]{36})["']/i.exec(result.stdout ?? '');
	return found?.[1] ?? null;
}

/**
 * Ключ Discord из data в секреты Cloudflare. В файлах проекта секретам не место,
 * а руками их вводить незачем — они уже лежат рядом, если сайт работал дома.
 */
function pushSecret(name, fileName) {
	const file = path.join(dataPath, fileName);

	if (!fs.existsSync(file)) {
		console.log(`  ${name}: файла data/${fileName} нет, пропускаю`);
		return false;
	}

	const value = fs.readFileSync(file, 'utf8').trim();

	if (!value) {
		console.log(`  ${name}: файл data/${fileName} пуст, пропускаю`);
		return false;
	}

	const result = wrangler(['secret', 'put', name], { input: value });

	if (result.status !== 0) {
		process.stderr.write(result.stderr ?? '');
		console.log(`  ${name}: не вышло`);
		return false;
	}

	console.log(`  ${name}: записан`);
	return true;
}

function main() {
	const config = fs.readFileSync(configPath, 'utf8');

	if (!config.includes(PLACEHOLDER)) {
		console.log('В wrangler.jsonc уже вписан номер базы — заводить нечего.');
		console.log('Если базу нужно сменить, поставьте на её место заглушку и запустите снова:');
		console.log(`  "database_id": "${PLACEHOLDER}"`);
	} else {
		const id = existingDatabaseId() ?? createDatabase();

		if (!id) {
			console.error('\nНе получилось завести базу D1.');
			console.error('Проверьте, что вход выполнен: npx wrangler login');
			process.exit(1);
		}

		fs.writeFileSync(configPath, config.replace(PLACEHOLDER, id), 'utf8');
		console.log(`\nБаза D1 «${DB_NAME}» готова, её номер вписан в wrangler.jsonc.`);
	}

	console.log('\nКлючи Discord:');
	pushSecret('DISCORD_CLIENT_ID', 'discord-client-id.txt');
	pushSecret('DISCORD_CLIENT_SECRET', 'discord-client-secret.txt');

	console.log('\nГотово. Дальше: npm run deploy');
}

main();
