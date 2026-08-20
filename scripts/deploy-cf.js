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
 * Ключ нужен всем, кто выкладывает не руками, и здесь он давно не выручалка,
 * а то, на чём всё держится.
 *
 * Вход через браузер (`npx wrangler login`) для кнопки не годится. Пропуск
 * от него живёт час; продлить его wrangler может сам, но только когда его
 * запускают, и запущенный отсюда, из дочернего процесса без терминала, продлить
 * его смог не всегда. Со стороны это выглядит так: выложил сразу после входа —
 * прошло; вернулся через час — «In a non-interactive environment, it's necessary
 * to set a CLOUDFLARE_API_TOKEN». За 14 августа так сорвалось пять запусков
 * подряд, и все пять — уже после того, как час истёк. Сервер тут ни при чём:
 * один из сорвавшихся шёл из-под сервера, прожившего минуту.
 *
 * Постоянный ключ убирает всю эту механику разом: увидев его, wrangler не
 * читает ни файла с пропуском, ни чего бы то ни было ещё, и продлевать нечего.
 * Ночной обход в Actions живёт этим же ключом, только приезжает он туда
 * переменной из секретов репозитория.
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

/**
 * Что говорить, когда wrangler не смог доказать, что он — это мы.
 *
 * Своё сообщение у него самое непонятное из всех («non-interactive environment»),
 * и по нему не догадаться, что делать. Здесь говорим прямо и в том порядке,
 * в каком это помогает.
 *
 * Порядок именно такой, а не обратный, потому что вход через браузер эту работу
 * не держит: пропуск от него живёт час, обновляется он только тогда, когда
 * wrangler запускают, и запущенный отсюда обновить его смог не всегда. Днём
 * 14 августа выкладка сорвалась пять раз подряд, и каждый раз — после того,
 * как час истёк; между ними, в пределах часа после входа, та же самая выкладка
 * прошла. Перезапуск сервера, который здесь советовался раньше, ни при чём:
 * сорвавшийся запуск шёл из-под сервера, прожившего минуту.
 *
 * Постоянный ключ снимает вопрос целиком: увидев его, wrangler не читает ни
 * файла с пропуском, ни чего бы то ни было ещё, и обновлять там нечего.
 */
function authAdvice() {
	console.error('');
	console.error('Если написано про non-interactive environment или CLOUDFLARE_API_TOKEN —');
	console.error('дело во входе в Cloudflare, а не в самой выкладке.');
	console.error('');
	console.error('Как чинить насовсем — положить постоянный ключ в data/cloudflare-token.txt:');
	console.error('  dash.cloudflare.com → My Profile → API Tokens → Create Token,');
	console.error('  шаблон «Edit Cloudflare Workers», в правах добавить D1 → Edit.');
	console.error('Ключ не протухает, и эта ошибка больше не повторится.');
	console.error('');
	console.error('Разово, до следующего раза:  npx wrangler login');
	console.error('Пропуск от входа живёт час — выкладка после него пройдёт, следующая');
	console.error('может и не пройти.');
}

/**
 * Код выхода, годный для показа. Windows отдаёт упавшему процессу не код,
 * а номер исключения — 3221226505 и подобные восьмизначные числа. Сам wrangler
 * этим и заканчивает: сказав про вход, он валится внутри себя («Assertion
 * failed: !(handle->flags & UV_HANDLE_CLOSING)»), и наверх уезжает не «1»,
 * а бессмыслица, по которой на странице обновления не понять ничего.
 */
function exitCode(status) {
	return status === null || status === undefined || status >= 0xc0000000 ? 1 : status;
}

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

		if (args[0] === 'wrangler' && !CLOUDFLARE_ENV.CLOUDFLARE_API_TOKEN) {
			authAdvice();
		}

		process.exit(exitCode(result.status));
	}
}

/**
 * Проверка пропуска до того, как начнётся долгая работа.
 *
 * Раньше выкладка узнавала о протухшем пропуске последней: сначала пересобирались
 * три тысячи обложек, потом выгружалась база — и только потом первый же поход
 * к Cloudflare отвечал «non-interactive environment». Несколько минут работы
 * впустую, а сказанное в самом конце ещё и тонуло в выводе.
 *
 * Спрашиваем список баз D1 — один запрос, самый дешёвый из тех, что вообще
 * требуют пропуска. Заодно он подновляет пропуск: сходив к Cloudflare, wrangler
 * меняет часовой пропуск на новый, и следующим шагам достаётся свежий час,
 * а не его остаток.
 *
 * Не `whoami`, хотя он и напрашивается: без пропуска тот честно печатает
 * «You are not authenticated», но заканчивается нулём — то есть удачей. Такая
 * проверка пропускала бы дальше ровно тот случай, ради которого поставлена.
 *
 * С постоянным ключом проверять нечего: он не протухает, и лишний поход к
 * Cloudflare ничего бы не сказал.
 */
function checkAuth() {
	if (local || CLOUDFLARE_ENV.CLOUDFLARE_API_TOKEN) {
		return;
	}

	console.log('\n───── Пропуск Cloudflare ─────');

	const result = spawnSync('npx', ['wrangler', 'd1', 'list', '--json'], {
		cwd: root,
		stdio: ['ignore', 'pipe', 'pipe'],
		shell: process.platform === 'win32',
		env: { ...process.env },
	});

	if (result.status === 0) {
		console.log('Пропуск на месте и подновлён. Час на выкладку есть.');
		return;
	}

	console.error('Пропуска нет: Cloudflare нас не узнаёт, и отправлять наверх нечем.');
	console.error('Ничего не тронуто — ни дома, ни на сайте.');
	authAdvice();

	process.exit(1);
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
		console.error('Положить руками: npm run state:push.');
		console.error('');
		console.error('Не откладывайте: пока на полке лежит прежнее, здешняя разметка живёт');
		console.error('только здесь, и ближайшая сверка при запуске сайта уведёт её в sibase.prev.db.');
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

	// Первым делом, до всякой долгой работы: без пропуска наверх всё равно
	// ничего не уедет, а узнать об этом лучше сейчас, чем через пять минут
	checkAuth();

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
