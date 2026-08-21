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
//
// ————— почему заливка идёт запросами, а не файлом —————
//
// `wrangler d1 execute --file` кладёт файл на сторону D1 и просит его «импортировать».
// Импорт у D1 — работа исключительная: пока он идёт, база не отвечает никому,
// и сайт всё это время отдаёт «D1_ERROR: Currently processing a long-running import»
// вместо паков. Двадцатого августа один такой кусок переваривался двенадцать минут,
// и двенадцать минут сайт был мёртв — при том, что менялось в нём полторы тысячи
// строк из тринадцати тысяч.
//
// Поэтому те же самые запросы отправляются по одному обычным способом (D1 REST,
// /query). Чтения они не блокируют вовсе: посетитель видит то старую строку,
// то новую, но список паков у него открывается всегда. Заливка от этого дольше
// по минутам — три сотни запросов вместо девяти, — но идёт она в фоне, и её
// длительность никого не касается, а недоступность сайта касается всех.
//
// Файлом заливается только местная копия (--local): там ни импорта, ни посетителей.

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

/** Конец всему: сказать, на чём споткнулись, и уйти с годным кодом. */
function fail(command, args, status) {
	console.error(`\nСорвалось на: ${command} ${args.join(' ')}`);

	if (args[0] === 'wrangler' && !CLOUDFLARE_ENV.CLOUDFLARE_API_TOKEN) {
		authAdvice();
	}

	process.exit(exitCode(status));
}

/**
 * Запуск программы. Сорвалась — уносит с собой всю выкладку.
 *
 * Ключ `soft` это отменяет: вместо выхода вернётся то, чем программа ругалась,
 * и решать, что с этим делать, будет вызвавший (см. execute — там ждут чужую
 * заливку и пробуют снова).
 *
 * Ругань при `soft` печатается не самой программой, а нами: перехватить её
 * иначе нельзя. Появляется она поэтому разом, по концу работы. На вид выкладки
 * это не влияет — ошибок там несколько строк, а ход самой заливки идёт первым
 * потоком и по-прежнему уходит в лог сразу, строка за строкой.
 */
function run(command, args, { soft = false } = {}) {
	console.log(`\n$ ${command} ${args.join(' ')}`);

	const passed = Object.fromEntries(Object.entries(CLOUDFLARE_ENV).filter(([, value]) => value));

	const result = spawnSync(command, args, {
		cwd: root,
		stdio: soft ? ['inherit', 'inherit', 'pipe'] : 'inherit',
		shell: process.platform === 'win32',
		env: { ...process.env, ...passed },
	});

	const complaint = result.stderr ?? Buffer.alloc(0);

	if (soft) {
		process.stderr.write(complaint);
	}

	if (result.status === 0) {
		return null;
	}

	if (!soft) {
		fail(command, args, result.status);
	}

	return { status: result.status, complaint: complaint.toString('utf8') };
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

/**
 * Чем ругается D1, когда по базе уже льют — не мы.
 *
 * Заливка файла у D1 не мгновенна: файл кладётся на его сторону, а дальше база
 * какое-то время переваривает его сама, и вторую такую работу она в это время
 * не начинает. Отвечает при этом отказом: «Currently processing a long-running
 * import. Cannot start another import until that completes or times out».
 *
 * Ждать приходится не себя, а другого: база в Cloudflare одна, а отправляют
 * в неё двое — этот компьютер и ежечасный обход в GitHub Actions (см.
 * .github/workflows/hourly.yml). Общая очередь у обходов есть, но стережёт
 * она полку с базой, а не D1, и на здешнюю выкладку не распространяется вовсе.
 * Поэтому «отправить на сайт» в начале часа рано или поздно попадает ровно
 * в ту минуту, когда наверху переваривается чужая заливка.
 *
 * Раньше это валило всю выкладку целиком — со всеми уже собранной статикой,
 * выгруженной базой и залитыми до срыва кусками, — хотя ничего не сломалось
 * и делать надо было ровно одно: подождать. 20 августа так и вышло, на первом
 * же куске из семи.
 *
 * Своих импортов у выкладки больше нет (см. шапку файла), но чужие никуда
 * не делись: пока наверху переваривается импорт, D1 отвечает этим отказом
 * на любой запрос, в том числе на обычный INSERT. Поэтому ждать и повторять
 * умеют оба пути — и заливка запросами, и заливка файлом.
 *
 * «Not currently importing anything» — оттуда же, но с другого конца. Так
 * отвечает D1, когда wrangler начал импорт и пошёл спрашивать «готово?»,
 * а спрашивать уже нечего: импорт закончился (или его потеряли) раньше первого
 * вопроса. Для wrangler это ошибка — `pollUntilComplete` бросает её наружу
 * и уносит с собой всю выкладку, — а на деле это гонка, и лечится она тем же
 * самым: подождать и повторить. Повтор ничего не портит: кусок уже лежит
 * на стороне D1 и узнаётся по отпечатку, а сами запросы переносят повтор
 * спокойно (INSERT … ON CONFLICT DO UPDATE, см. scripts/export-d1.js).
 * 20 августа выкладка встала ровно на этом, на третьем куске из девяти.
 */
const IMPORT_BUSY = /long-running import|another import|not currently importing/i;

/**
 * Сколько ждать перед следующей попыткой, секунды. Сначала коротко — чужая
 * заливка обычно идёт кусками по паре мегабайт и переваривается быстро; дальше
 * длиннее, потому что если уж не успело, то там что-то большое. Всего около
 * четверти часа: не дождались за это время — дело не в очереди, и врать про
 * «сейчас пройдёт» не стоит.
 */
const BUSY_WAITS = [15, 30, 60, 120, 240, 300];

/** Подождать, ничего не делая. Здесь всё идёт по порядку и сплошняком, поэтому так. */
function sleep(seconds) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
}

/**
 * Заливка файла SQL. Куда — решает --local: в местную копию или в настоящую базу.
 *
 * Наткнулись на чужую заливку — ждём и пробуем снова. Повторная попытка дешева:
 * файл на стороне D1 уже лежит, wrangler узнаёт его по отпечатку и второй раз
 * не отправляет («File already uploaded. Processing»).
 */
function execute(file) {
	const args = ['wrangler', 'd1', 'execute', DB_NAME, local ? '--local' : '--remote', `--file=${file}`, '-y'];

	// Местная копия лежит рядом с проектом, и делить её не с кем: ждать там
	// нечего и некого, а лишний перехват вывода только запутает
	if (local) {
		run('npx', args);
		return;
	}

	for (let attempt = 0; ; attempt += 1) {
		const failure = run('npx', args, { soft: true });

		if (!failure) {
			return;
		}

		if (!IMPORT_BUSY.test(failure.complaint)) {
			fail('npx', args, failure.status);
		}

		if (attempt >= BUSY_WAITS.length) {
			console.error('');
			console.error('Наверху всё это время переваривается чужая заливка, и наша очередь так и не подошла.');
			console.error('Дома всё цело: отметка «доехало» не ставится до конца, и следующая отправка');
			console.error('пошлёт ровно те же строки. Проще всего — повторить попозже кнопкой');
			console.error('«Отправить на сайт заново».');

			fail('npx', args, failure.status);
		}

		const wait = BUSY_WAITS[attempt];

		console.log(`\nНаверху идёт другая заливка — скорее всего ежечасный обход.`);
		console.log(`Это не ошибка: ждём ${wait} с и пробуем снова (попытка ${attempt + 2}).`);

		sleep(wait);
	}
}

/** Куда стучаться напрямую, без wrangler. */
const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';

/** Номер базы D1. Лежит в wrangler.jsonc — его туда вписывает `npm run cf:setup`. */
function databaseId() {
	const config = fs.readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8');

	return /"database_id"\s*:\s*"([^"]+)"/.exec(config)?.[1] ?? '';
}

/**
 * Номер учётной записи. Обычно он не нужен вовсе — wrangler находит её сам, —
 * но REST без него не работает: адрес запроса начинается с учётной записи.
 *
 * Поэтому если его не сказали ни переменной, ни файлом, спрашиваем сами:
 * учётных записей у ключа чаще всего одна, а когда их несколько, нужную видно
 * по базе — она в ней или её там нет.
 */
let knownAccount = null;

async function accountId() {
	if (knownAccount !== null) {
		return knownAccount;
	}

	if (CLOUDFLARE_ENV.CLOUDFLARE_ACCOUNT_ID) {
		knownAccount = CLOUDFLARE_ENV.CLOUDFLARE_ACCOUNT_ID;
		return knownAccount;
	}

	const response = await fetch(`${CLOUDFLARE_API}/accounts`, {
		headers: { Authorization: `Bearer ${CLOUDFLARE_ENV.CLOUDFLARE_API_TOKEN}` },
	});

	const body = await response.json().catch(() => null);
	const accounts = body?.result ?? [];

	for (const account of accounts) {
		const check = await fetch(`${CLOUDFLARE_API}/accounts/${account.id}/d1/database/${databaseId()}`, {
			headers: { Authorization: `Bearer ${CLOUDFLARE_ENV.CLOUDFLARE_API_TOKEN}` },
		});

		if (check.ok) {
			knownAccount = account.id;
			return knownAccount;
		}
	}

	console.error('\nCloudflare не показал учётной записи, в которой лежит база firepacks.');
	console.error('Впишите её номер в data/cloudflare-account.txt (dash.cloudflare.com, справа внизу).');
	process.exit(1);
}

/**
 * Один запрос к базе наверху. Отказ возвращается строкой, а не бросается:
 * решать, ждать его или сдаваться, будет позвавший (см. IMPORT_BUSY).
 *
 * @returns {Promise<string|null>} null — получилось; строка — чем ругались
 */
async function askDatabase(sql) {
	const account = await accountId();

	let response;

	try {
		response = await fetch(`${CLOUDFLARE_API}/accounts/${account}/d1/database/${databaseId()}/query`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${CLOUDFLARE_ENV.CLOUDFLARE_API_TOKEN}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ sql }),
		});
	} catch (error) {
		// Оборванная сеть — не отказ базы, а помеха по дороге: такое повторяют
		return `сеть: ${error.message}`;
	}

	const body = await response.json().catch(() => null);

	if (response.ok && body?.success) {
		return null;
	}

	const complaints = (body?.errors ?? []).map(item => item.message).filter(Boolean);

	return complaints.join('; ') || `HTTP ${response.status}`;
}

/**
 * Отказы, которые проходят сами: чужая заливка (см. IMPORT_BUSY), обрыв сети
 * и «слишком часто» от самого Cloudflare. Всё остальное — наша ошибка в SQL,
 * и повторять её бессмысленно.
 */
const WORTH_RETRY = /^сеть: |too many requests|rate limit|HTTP (429|5\d\d)|internal error|network connection lost/i;

/**
 * Разбор выгрузки на отдельные запросы.
 *
 * Резать по «;» напрямую нельзя: точка с запятой попадается и внутри строк —
 * в названиях тем («Игры;Кино;Мир»), в тексте сообщения, в описании. Поэтому
 * идём по знакам и считаем апострофы: удвоенный апостроф внутри строки («don''t»)
 * закрывает её и тут же открывает снова, то есть сам собой считается правильно.
 */
function statementsOf(sql) {
	const statements = [];
	let start = 0;
	let quoted = false;

	for (let i = 0; i < sql.length; i++) {
		const symbol = sql[i];

		if (quoted) {
			if (symbol === "'") {
				quoted = false;
			}

			continue;
		}

		if (symbol === "'") {
			quoted = true;
			continue;
		}

		// Пояснение до конца строки: им начинается каждый файл выгрузки
		if (symbol === '-' && sql[i + 1] === '-') {
			const end = sql.indexOf('\n', i);
			i = end === -1 ? sql.length : end;
			continue;
		}

		if (symbol === ';') {
			const statement = sql.slice(start, i).trim();

			if (statement) {
				statements.push(statement);
			}

			start = i + 1;
		}
	}

	const rest = sql.slice(start).trim();

	if (rest) {
		statements.push(rest);
	}

	return statements;
}

/**
 * Заливка файла запрос за запросом. Медленнее файла целиком, зато сайт всё это
 * время открывается — ради этого всё и затевалось (см. шапку файла).
 *
 * По одному, а не пачками и не в несколько потоков, нарочно: в выгрузке
 * попадаются DELETE перед INSERT по тем же строкам (см. scripts/export-d1.js),
 * и порядок здесь — не формальность.
 */
async function pourByQueries(file) {
	const full = path.isAbsolute(file) ? file : path.join(root, file);
	const statements = statementsOf(fs.readFileSync(full, 'utf8'));

	console.log(`\n$ ${path.basename(file)}: ${statements.length} запрос(ов) в базу наверху`);

	for (let index = 0; index < statements.length; index++) {
		for (let attempt = 0; ; attempt += 1) {
			const complaint = await askDatabase(statements[index]);

			if (!complaint) {
				break;
			}

			const busy = IMPORT_BUSY.test(complaint);

			if (!busy && !WORTH_RETRY.test(complaint)) {
				console.error(`\nБаза наверху отказала на запросе ${index + 1} из ${statements.length}:`);
				console.error(complaint);
				console.error('\nДома всё цело: отметка «доехало» не ставится до конца, и следующая');
				console.error('отправка пошлёт те же строки заново.');
				process.exit(1);
			}

			if (attempt >= BUSY_WAITS.length) {
				console.error(`\nНе дождались: ${complaint}`);
				console.error('Следующая отправка пошлёт те же строки заново.');
				process.exit(1);
			}

			const wait = BUSY_WAITS[attempt];

			console.log(busy
				? `Наверху идёт чужая заливка — ждём ${wait} с и пробуем снова.`
				: `Не прошло (${complaint}) — ждём ${wait} с и пробуем снова.`);

			sleep(wait);
		}

		// Каждый пятидесятый — чтобы по логу было видно, что заливка идёт,
		// и при этом он не превращался в простыню из трёхсот строк
		if ((index + 1) % 50 === 0) {
			console.log(`  ${index + 1} из ${statements.length}`);
		}
	}
}

/**
 * Залить файл наверх. Чем — решается здесь: обычными запросами, если есть ключ,
 * и по-старому файлом, если его нет.
 *
 * Второй путь остался не для красоты: без постоянного ключа REST невозможен вовсе
 * (пропуском из браузера он не пользуется), а выкладка руками после `wrangler login`
 * — обычное дело. Сайт при этом на время заливки ляжет, но лучше так, чем никак.
 */
async function pour(file) {
	if (local || !CLOUDFLARE_ENV.CLOUDFLARE_API_TOKEN) {
		execute(file);
		return;
	}

	await pourByQueries(file);
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

async function main() {
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
	await pour('cf/schema.sql');

	console.log('\n───── Паки ─────');

	for (const name of fs.readdirSync(dataPath).sort()) {
		await pour(path.join('cf', 'data', name));
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

await main();
