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
 * Класть ли базу на полку после удачной заливки. По умолчанию — да, и это
 * не мелочь, а вторая половина сверки (см. scripts/state.js): здешний запуск
 * сайта подгоняет базу под полку, значит на полке обязано лежать ровно то,
 * что стоит на сайте. Не положить сюда — и следующий запуск дома вернёт
 * вчерашнюю копию, стерев то, что только что уехало наверх.
 *
 * Ключ --no-state снимает это для разовых случаев. В GitHub Actions полка
 * и так обновляется отдельным шагом (.github/workflows/nightly.yml) — второй
 * раз гнать туда семьдесят мегабайт незачем.
 */
const toShelf = !local && !process.argv.includes('--no-state') && !process.env.GITHUB_ACTIONS;

/**
 * Местная копия — всегда целиком и без отметки «доехало». Она живёт в .wrangler
 * рядом с проектом и к настоящей базе в Cloudflare отношения не имеет: запомнить
 * по ней, что там уже лежит, значило бы соврать самим себе, и следующая настоящая
 * выкладка недосчиталась бы всего, что проверялось на местной.
 */
const whole = local || process.argv.includes('--full');

const DB_NAME = 'firepacks';

/**
 * Секреты сюда не пишутся: сначала переменная окружения, потом файл в папке data.
 * Тот же порядок и те же файлы, что у остальных ключей проекта (см. src/config.js);
 * повторено здесь, а не взято оттуда, нарочно — этот скрипт запускается и в GitHub
 * Actions, где никакого config.js с его настройками не нужно вовсе.
 */
function readSecret(envName, fileName) {
	if (process.env[envName]) {
		return process.env[envName].trim();
	}

	try {
		return fs.readFileSync(path.join(root, 'data', fileName), 'utf8').trim();
	} catch {
		return '';
	}
}

/**
 * Чем wrangler будет доказывать, что он — это мы.
 *
 * Обычно ничем: своего входа (`npx wrangler login`) хватает и здесь, и кнопке
 * «Задеплоить на сайт» — дочерний процесс без всякого терминала выкладывает
 * ровно так же. Пропуск от входа живёт час и обновляется сам.
 *
 * Ключ нужен там, где входить некому: ночному обходу в Actions (он приезжает
 * переменной из секретов репозитория) — и как выручалка, если wrangler вдруг
 * заявляет «non-interactive environment». Такое случалось у кнопки: запущенный
 * из-под одного сервера wrangler своего пропуска не видел, а из-под свежего —
 * видел, и отчего так, выяснить не вышло. Перезапуск сервера лечит; постоянный
 * ключ снимает вопрос совсем, потому что не протухает.
 *
 * Кладётся в data/cloudflare-token.txt (папка под .gitignore, как и остальные
 * ключи). Переменная окружения старше файла — в Actions файла нет вовсе.
 *
 * Заводится на dash.cloudflare.com → My Profile → API Tokens → Create Token,
 * шаблон «Edit Cloudflare Workers», и в правах добавить D1 → Edit.
 */
const CLOUDFLARE_ENV = {
	CLOUDFLARE_API_TOKEN: readSecret('CLOUDFLARE_API_TOKEN', 'cloudflare-token.txt'),
	// Номер учётной записи нужен только тогда, когда их у ключа несколько:
	// с одной wrangler определяет её сам. Пустое значение не передаём — иначе
	// wrangler примет пустую строку за ответ и станет искать учётную запись «».
	CLOUDFLARE_ACCOUNT_ID: readSecret('CLOUDFLARE_ACCOUNT_ID', 'cloudflare-account.txt'),
};

function run(command, args) {
	console.log(`\n$ ${command} ${args.join(' ')}`);

	const passed = Object.fromEntries(Object.entries(CLOUDFLARE_ENV).filter(([, value]) => value));

	const result = spawnSync(command, args, {
		cwd: root,
		stdio: 'inherit',
		shell: process.platform === 'win32',
		env: { ...process.env, ...passed },
	});

	if (result.status !== 0) {
		console.error(`\nСорвалось на: ${command} ${args.join(' ')}`);

		// Отдельно про вход: сообщение у wrangler самое непонятное из всех, и по
		// нему не догадаться, что делать. Здесь говорим прямо и в том порядке,
		// в каком это чаще всего помогает.
		if (args[0] === 'wrangler' && !CLOUDFLARE_ENV.CLOUDFLARE_API_TOKEN) {
			console.error('');
			console.error('Если написано про non-interactive environment или CLOUDFLARE_API_TOKEN —');
			console.error('дело во входе в Cloudflare, а не в самой выкладке. По порядку:');
			console.error('');
			console.error('  • перезапустите сервер, если выкладку запускала кнопка: у сервера,');
			console.error('    прожившего долго, wrangler перестаёт видеть свой пропуск;');
			console.error('  • войдите заново:  npx wrangler login');
			console.error('  • или положите постоянный ключ в data/cloudflare-token.txt');
			console.error('    (dash.cloudflare.com → My Profile → API Tokens → Create Token,');
			console.error('    шаблон «Edit Cloudflare Workers», в правах добавить D1 → Edit).');
			console.error('');
			console.error('Последнее снимает вопрос насовсем: ключ не протухает, а пропуск от входа');
			console.error('живёт час.');
		}

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
	const id = readSecret('DISCORD_CLIENT_ID', 'discord-client-id.txt');
	const secret = readSecret('DISCORD_CLIENT_SECRET', 'discord-client-secret.txt');

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

/**
 * Положить базу на полку — ту самую, с которой её берёт запуск сайта дома
 * и ночной обход в облаке.
 *
 * Сорвалось — говорим и живём дальше: сайт-то уже обновлён, и валить из-за
 * этого всю выкладку не за что. Но сказать надо громко: пока на полке лежит
 * прежнее, здешняя база расходится с сайтом, и первая же сверка вернёт её
 * к вчерашнему виду.
 */
function shelve() {
	console.log('\n───── Полка ─────');

	const result = spawnSync(process.execPath, ['--no-warnings', 'scripts/state.js', 'push'], {
		cwd: root,
		stdio: 'inherit',
	});

	if (result.status !== 0) {
		console.error('');
		console.error('На полку база не легла. Сайт при этом обновлён — расходится только полка.');
		console.error('Положить руками: npm run state:push (а если полка новее — npm run state:push -- --force).');
	}
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

		if (toShelf) {
			shelve();
		}

		return;
	}

	console.log('\n───── Выкладка ─────');
	run('npx', ['wrangler', 'deploy']);

	if (toShelf) {
		shelve();
	}

	console.log('\nГотово.');
}

main();
