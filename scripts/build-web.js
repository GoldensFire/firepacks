// Сборка того, что Cloudflare отдаёт из статики: вёрстка, скрипты, значок
// и уменьшенные обложки. Всё складывается в cf/public — папку целиком
// перезаписывает каждая сборка, руками там делать нечего.
//
// Обложки уменьшаются здесь, а не на сайте, как дома: на Workers картинку
// уменьшать нечем, да и незачем — обложки меняются раз в неделю, а страницы
// открывают каждый день. Все копии складываются в AVIF, каким бы ни был
// оригинал: имя копии считает thumbName в src/settings.js, и то же имя ставит
// в ссылку Worker — иначе обложек не будет ни одной.
//
// Уменьшается при этом только то, чего ещё нет: готовые копии лежат в data/thumbs
// и переживают сборку (см. cachePath ниже).
//
// Страница обновления базы наверх не уезжает вовсе: не «уезжает и прячется»,
// а не уезжает — там её нет, и открыть её по прямой ссылке не выйдет.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { resizeInto } from '../src/thumbs.js';
import { thumbName } from '../src/settings.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webPath = path.join(root, 'web');
const logosPath = path.join(root, 'data', 'logos');
const publicPath = path.join(root, 'cf', 'public');
const thumbsPath = path.join(publicPath, 'logos', 'thumb');

/**
 * Склад готовых уменьшенных обложек. Живёт отдельно от cf/public, который
 * переписывается каждой сборкой, — и в этом весь смысл.
 *
 * Раньше все копии делались заново при каждой выкладке: четыре сотни запусков
 * ImageMagick ради того, чтобы получить те же самые файлы, что и вчера. На
 * пятнадцати тысячах паков это уже не мелочь, а десятки минут на пустом месте.
 *
 * Второе, ради чего это здесь, важнее первого. Ночной обход переехал в GitHub
 * Actions, а туда не увезти оригиналы обложек: их семьдесят мегабайт на четыре
 * сотни паков, то есть больше двух гигабайт на пятнадцать тысяч. Уменьшенные
 * копии весят на два порядка меньше и ездят вместе с базой (см. scripts/state.js).
 * Оригинал нужен ровно один раз — в ту ночь, когда пак разобрали впервые,
 * и он в эту же ночь скачивается разбором.
 */
const cachePath = path.join(root, 'data', 'thumbs');

/** Страница обновления базы и её скрипт. На хостинге обновлять нечем. */
const SKIP = new Set(['update.html', 'update.js']);

/**
 * Файлы, которые уезжают наверх байт в байт, без единой правки, — подтверждения
 * прав на сайт для Google Search Console и Яндекс.Вебмастера.
 *
 * Оба поисковика проверяют такой файл не глазами, а сверкой содержимого, и любая
 * приписка к нему — отпечаток в ссылке, счётчик посещений перед `</body>` —
 * означает «подтверждение не прошло». Расширение у них при этом .html, то есть
 * под общую правку вёрстки они попадают первыми; отсюда этот список.
 *
 * Имена не выдуманы: у Google это то же имя, что и выданный им код, у Яндекса —
 * `yandex_<код>.html`. Переименовывать их нельзя — по этим адресам поисковик
 * и приходит.
 */
const RAW = new Set(['googlec52a37e47b9088a6.html', 'yandex_42c0743c2b5d2eb6.html']);

/**
 * Счётчик посещений Cloudflare. Приписывается здесь, а не в самой вёрстке,
 * нарочно: домашний сайт открывают тот же десяток раз в день, что и настоящий,
 * и стой этот скрипт в web/*.html — половина статистики оказалась бы про
 * localhost. Наверх уезжает собранная копия, её и метим.
 *
 * Ключ здесь не секрет и прятать его негде: он всё равно лежит открытым текстом
 * в каждой странице сайта — этим счётчик и работает.
 */
const ANALYTICS = `<!-- Cloudflare Web Analytics -->`
	+ `<script type="module" src="https://static.cloudflareinsights.com/beacon.min.js"`
	+ ` data-cf-beacon='{"token": "65f46cc707d64693b45688862ae8ae67"}'></script>`
	+ `<!-- End Cloudflare Web Analytics -->`;

/**
 * Второй счётчик — Google Analytics 4. Стоит рядом с первым и по той же причине
 * приписывается сборкой, а не вёрсткой: домашний сайт открывают столько же раз,
 * сколько настоящий, и попади этот кусок в web/*.html — половина статистики
 * оказалась бы про localhost.
 *
 * Счётчики друг другу не мешают: у Cloudflare свой скрипт и свой сбор, у Google
 * свой, общего между ними нет ничего. Номер (G-…) — не секрет, он открытым
 * текстом лежит в каждой странице любого сайта с этим счётчиком.
 *
 * Официальный кусок Google даётся без изменений — ни async, ни порядок строк
 * трогать не надо: gtag.js подгружается сам, а очередь событий (dataLayer)
 * заводится до него и переживает загрузку.
 */
const GOOGLE_TAG_ID = 'G-B411NVCDBB';

const GOOGLE_ANALYTICS = `<!-- Google tag (gtag.js) -->`
	+ `<script async src="https://www.googletagmanager.com/gtag/js?id=${GOOGLE_TAG_ID}"></script>`
	+ `<script>`
	+ `window.dataLayer = window.dataLayer || [];`
	+ `function gtag(){dataLayer.push(arguments);}`
	+ `gtag('js', new Date());`
	+ `gtag('config', '${GOOGLE_TAG_ID}');`
	+ `</script>`
	+ `<!-- End Google tag -->`;

/**
 * Скрипты и стили, к которым дописывается отпечаток содержимого. Ссылки на них
 * стоят в вёрстке, и сборка их переписывает: /app.js → /app.js?v=1a2b3c4d.
 */
const VERSIONED = [
	'app.js', 'common.js', 'icons.js', 'card.js', 'pack.js',
	'authors.js', 'profile.js', 'top.js', 'subjects.js', 'landing.js', 'style.css',
];

/**
 * Значок туда же, хотя лежит он не в web, а в корне проекта. Имя у него одно
 * и то же всегда, а сам файл иногда меняют, — и без отпечатка новый значок
 * не появлялся бы неделю: ровно столько его держит у себя браузер (см. HEADERS).
 * Выглядит это как «замену не приняли», хотя файл давно другой.
 */
const ICON = 'favicon.ico';

/** Отпечаток содержимого: восьми знаков хватает, чтобы имена не совпали. */
const fingerprint = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 8);

/**
 * Заголовки, которые Cloudflare проставит сам, без участия Worker.
 *
 * Обложки — самое тяжёлое, что отдаёт сайт: их под четыре сотни, и на страницу
 * их разом приходит два десятка. Кэш им поэтому нужен, но вечного им нельзя,
 * и это стоило сайта всех свежих обложек разом.
 *
 * Здесь стояло «max-age=31536000, immutable» — с объяснением, что файл обложки
 * никогда не меняется. Про файл это правда, а правило прикладывается не к файлу,
 * а к адресу, и уезжает оно с любым ответом по этому адресу, включая «такой
 * обложки нет». А «нет» здесь случается постоянно: строка пака уезжает в D1
 * одной выкладкой, уменьшенная копия появляется следующей, и всякий, кто открыл
 * пак между ними, запоминал пустоту на год. Не «показывал старое, пока не
 * спросит заново», а не спрашивал вовсе: immutable — это обещание, что
 * переспрашивать незачем. Обложка приезжала на сайт, лежала там целой,
 * и человек всё равно видел квадрат с буквой (паки 15915–15917, 16554).
 *
 * Теперь сутки и без immutable. Промах забывается назавтра сам, а лишним
 * расходом это не оборачивается: ETag у файлов есть, и на второй день браузеру
 * приходит «не менялось» в несколько десятков байт. Заодно в самой ссылке
 * появился отпечаток (см. LOGO_VERSION в src/settings.js) — им достучались
 * до тех, кто уже запомнил год и потому этого правила никогда бы не увидел.
 *
 * Скриптам и стилям теперь можно то же самое, и это главное здешнее ускорение:
 * раньше они менялись с каждой выкладкой, вечный кэш означал бы старый сайт
 * у всех, кто уже заходил, — и потому браузер спрашивал про каждый из них заново
 * при каждом открытии страницы (сто с лишним килобайт и по ходке до сервера
 * на файл, даже когда в ответ приходит «не менялось»). Теперь в ссылке стоит
 * отпечаток содержимого: правка кода меняет ссылку, а по неизменной ссылке
 * лежит навсегда неизменный файл — спрашивать про него незачем.
 *
 * Вёрстке вечный кэш по-прежнему нельзя: именно она приносит новые ссылки.
 * Отдельного правила ей тут нет и не надо — всему, что здесь не названо,
 * Cloudflare сам ставит «спрашивать каждый раз», а страницы к тому же лежат
 * не по тем адресам, по которым их открывают: /profile отдаётся из profile.html,
 * и правило по расширению до него всё равно бы не дотянулось.
 */
const HEADERS = `# Собрано scripts/build-web.js

/logos/thumb/*
  Cache-Control: public, max-age=86400

${VERSIONED.map(name => `/${name}\n  Cache-Control: public, max-age=31536000, immutable`).join('\n\n')}

/favicon.ico
  Cache-Control: public, max-age=604800
`;

// Неделя значку теперь не страшна: в вёрстке на него стоит ссылка с отпечатком
// (см. ICON), и после замены файла адрес будет другой. По голому /favicon.ico
// ходят закладки и старые вкладки — им неделя как раз впору.

/** Обложки, на которые ссылается база. Лишние наверх не уезжают. */
function usedLogos() {
	const dbPath = path.join(root, 'data', 'sibase.db');

	if (!fs.existsSync(dbPath)) {
		return [];
	}

	const db = new DatabaseSync(dbPath, { readOnly: true });

	const rows = db.prepare(`
		SELECT DISTINCT logo_file FROM packages
		WHERE status = 'ok' AND logo_state = 'ok' AND logo_file IS NOT NULL
	`).all();

	db.close();
	return rows.map(row => row.logo_file);
}

/**
 * Опустошает папку, не удаляя её саму. Разница не косметическая: во время
 * проверки за cf/public смотрит `wrangler dev`, и Windows не даёт удалить папку,
 * на которую кто-то смотрит, — сборка падала на ровном месте с «EPERM».
 * Содержимое при этом удаляется прекрасно.
 */
function clearDirectory(directory) {
	fs.mkdirSync(directory, { recursive: true });

	for (const name of fs.readdirSync(directory)) {
		fs.rmSync(path.join(directory, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
}

async function main() {
	clearDirectory(publicPath);
	fs.mkdirSync(thumbsPath, { recursive: true });

	let pages = 0;

	for (const name of fs.readdirSync(webPath)) {
		if (SKIP.has(name)) {
			continue;
		}

		fs.copyFileSync(path.join(webPath, name), path.join(publicPath, name));
		pages++;
	}

	// Значок лежит в корне проекта рядом с ярлыками, а не в папке сайта:
	// дома его отдаёт сервер как /favicon.ico, здесь он просто там и лежит.
	fs.copyFileSync(path.join(root, 'icon.ico'), path.join(publicPath, 'favicon.ico'));

	// Отпечатки в ссылках. Считаются по уже скопированным файлам — по тем самым,
	// которые уедут наверх, а не по их исходникам. Правится только вёрстка:
	// имена самих файлов остаются прежними, меняется лишь адрес, по которому
	// их просят, и этого хватает, чтобы браузер взял новый файл вместо старого.
	const stamps = new Map();

	for (const name of [...VERSIONED, ICON]) {
		const file = path.join(publicPath, name);

		if (fs.existsSync(file)) {
			stamps.set(name, fingerprint(file));
		}
	}

	for (const name of fs.readdirSync(publicPath)) {
		if (!name.endsWith('.html') || RAW.has(name)) {
			continue;
		}

		const file = path.join(publicPath, name);
		let html = fs.readFileSync(file, 'utf8');

		for (const [asset, stamp] of stamps) {
			html = html.replaceAll(`"/${asset}"`, `"/${asset}?v=${stamp}"`);
		}

		// Счётчики посещений — последними, перед самым закрытием страницы: грузятся
		// они со стороны и к тому, что показано, отношения не имеют, поэтому ждать
		// их вёрстке незачем
		html = html.replace('</body>', `${ANALYTICS}\n${GOOGLE_ANALYTICS}\n</body>`);

		fs.writeFileSync(file, html, 'utf8');
	}

	fs.writeFileSync(path.join(publicPath, '_headers'), HEADERS, 'utf8');

	const logos = usedLogos();
	const failed = [];
	let resized = 0;
	let reused = 0;
	let missing = 0;

	fs.mkdirSync(cachePath, { recursive: true });

	await Promise.all(logos.map(async file => {
		const source = path.join(logosPath, file);
		const cached = path.join(cachePath, thumbName(file));
		const original = fs.statSync(source, { throwIfNoEntry: false });
		const copy = fs.statSync(cached, { throwIfNoEntry: false });

		// Готовая копия годится, пока оригинал не стал новее её. Оригинала может
		// не быть вовсе — так и выглядит ночной обход в облаке, — и тогда сверять
		// не с чем: копия и есть всё, что у нас про эту обложку есть.
		if (copy && (!original || original.mtimeMs <= copy.mtimeMs)) {
			fs.copyFileSync(cached, path.join(thumbsPath, thumbName(file)));
			reused++;
			return;
		}

		if (!original) {
			missing++;
			return;
		}

		// Уменьшить не вышло — обложка не уезжает вовсе. Положить вместо неё
		// оригинал нельзя: имя копии оканчивается на .avif, Content-Type
		// Cloudflare ставит по расширению, и браузер получил бы jpg под видом
		// avif — то есть не картинку, а ошибку. Без файла карточка покажет
		// квадрат с первой буквой названия, что честнее.
		if (await resizeInto(source, cached)) {
			fs.copyFileSync(cached, path.join(thumbsPath, thumbName(file)));
			resized++;
		} else {
			failed.push(file);
		}
	}));

	// Копии паков, которых в базе больше нет. Без уборки склад рос бы вечно,
	// а ездит он теперь вместе с базой.
	const wanted = new Set(logos.map(file => thumbName(file)));
	let swept = 0;

	for (const name of fs.readdirSync(cachePath)) {
		if (!wanted.has(name)) {
			fs.rmSync(path.join(cachePath, name), { force: true });
			swept++;
		}
	}

	const weigh = directory => fs.readdirSync(directory)
		.reduce((sum, name) => sum + fs.statSync(path.join(directory, name)).size, 0);

	console.log(`  вёрстка: ${pages} файл(ов), со счётчиками посещений`);
	console.log(`  обложки: ${reused} готовых, ${resized} уменьшено, ${failed.length} не вышло, ${missing} не нашлось`
		+ `${swept > 0 ? `, ${swept} лишних убрано со склада` : ''}`);
	console.log(`Собрано в cf/public, обложки весят ${(weigh(thumbsPath) / 1024 / 1024).toFixed(1)} МБ.`);

	if (failed.length > 0) {
		console.log(`\nЭти обложки уменьшить не вышло, и на сайте их не будет: ${failed.slice(0, 10).join(', ')}`);
		console.log('Если не вышло вообще ни одной — поставьте ImageMagick или ffmpeg.');
	}
}

await main();
