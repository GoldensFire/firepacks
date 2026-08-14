// Шапка страницы пака и карта сайта — всё, что сайт говорит про пак не человеку,
// а поисковику.
//
// У каждого пака теперь своя страница (/pack/…), и рисует её тот же скрипт, что
// и карточку в выдаче, — то есть на языке поисковика страница приходит пустой,
// а название пака появляется в ней потом, когда отработает JS. Заголовок вкладки
// и описание в выдаче так не получить: их читают из самой вёрстки, поэтому сервер
// подставляет их в неё до отправки. Это единственное место, где сайт вообще
// собирает HTML руками.
//
// Общее для дома и Cloudflare нарочно: страница пака там и там одна и та же,
// и разъехаться её заголовкам незачем (см. cf/src/index.js и src/server.js).

import { LEVELS, TOPICS } from './settings.js';
import { packPath } from './slug.js';

/** В HTML нельзя как есть: название пака вполне может содержать кавычки и «<». */
export function escapeHtml(text) {
	return String(text ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/**
 * Русское склонение по числу: 1 вопрос, 2 вопроса, 5 вопросов. Такое же, как
 * на самом сайте (см. plural в web/common.js), но своё: тот файл читает браузер,
 * а этот — сервер, и одолжить оттуда нечего.
 */
function plural(count, one, few, many) {
	const mod10 = count % 10;
	const mod100 = count % 100;

	if (mod10 === 1 && mod100 !== 11) {
		return one;
	}

	if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) {
		return few;
	}

	return many;
}

/** Заголовок вкладки и строка выдачи: «Гарри Поттер — пак SIGame от Vieldy». */
function packTitle(pack) {
	const name = (pack.name ?? pack.fileName ?? '').trim() || 'Пак без названия';
	const author = pack.authors?.[0];

	return `${name} — пак SIGame${author ? ` от ${author}` : ''}`;
}

/**
 * Описание под ссылкой в поисковой выдаче. Собирается из того, что про пак
 * известно наверняка, и начинается с пересказа от нейросети, если он есть:
 * это единственная строка, которая отвечает на вопрос «о чём пак», словами.
 *
 * Длина держится в пределах двух с небольшим сотен знаков: длиннее выдача всё
 * равно обрежет, и обрежет посередине слова.
 */
function packDescription(pack) {
	const parts = [];

	if (pack.summary) {
		parts.push(pack.summary.trim().replace(/\s+/g, ' '));
	}

	const topic = pack.primaryTopic ? TOPICS[pack.primaryTopic]?.packName : null;

	if (topic) {
		parts.push(topic);
	}

	if (pack.questionCount) {
		parts.push(`${pack.questionCount} ${plural(pack.questionCount, 'вопрос', 'вопроса', 'вопросов')}`);
	}

	if (pack.roundCount) {
		parts.push(`${pack.roundCount} ${plural(pack.roundCount, 'раунд', 'раунда', 'раундов')}`);
	}

	const level = pack.stats?.level ? LEVELS[pack.stats.level]?.name : null;

	if (level) {
		parts.push(`сложность: ${level.toLowerCase()}`);
	}

	if (pack.authors?.length > 0) {
		parts.push(`автор: ${pack.authors.join(', ')}`);
	}

	parts.push('играть онлайн или скачать');

	const text = parts.join('. ');
	return text.length > 260 ? `${text.slice(0, 257).trimEnd()}…` : text;
}

/**
 * Разметка Schema.org для страницы пака — то же самое, что и в шапке, только
 * в виде, который поисковик разбирает не догадками, а по полям: что это за
 * вещь, кто автор, сколько людей её оценили.
 *
 * Тип — CreativeWork, а не VideoGame: пак это не игра, а набор вопросов
 * для чужого движка, и обещать поисковику игру значило бы врать ему про
 * платформы и жанры, которых у пака нет.
 *
 * Средняя оценка попадает сюда только с того же порога, что и на сайт
 * (см. minRatingsForScore): по трём оценкам среднее случайно, а в разметке
 * оно живёт своей жизнью и попадает прямо в выдачу звёздами.
 */
function packSchema(pack, canonical, image) {
	const name = (pack.name ?? pack.fileName ?? '').trim() || 'Пак без названия';

	const data = {
		'@context': 'https://schema.org',
		'@type': 'CreativeWork',
		name,
		url: canonical,
		description: packDescription(pack),
		inLanguage: pack.language ?? 'ru',
		genre: pack.primaryTopic ? TOPICS[pack.primaryTopic]?.packName : undefined,
		image: image ?? undefined,
		datePublished: pack.vkTs ? new Date(pack.vkTs).toISOString().slice(0, 10) : undefined,
		author: pack.authors?.length > 0
			? pack.authors.map(author => ({ '@type': 'Person', name: author }))
			: undefined,
		isPartOf: { '@type': 'CollectionPage', name: 'FirePacks', url: `${originOf(canonical)}/` },
		aggregateRating: pack.rating?.average
			? {
				'@type': 'AggregateRating',
				ratingValue: pack.rating.average,
				ratingCount: pack.rating.count,
				bestRating: 10,
				worstRating: 1,
			}
			: undefined,
	};

	// Хлебные крошки: по ним поисковик рисует путь под ссылкой вместо голого
	// адреса — «FirePacks › Жижка» вместо «firepacks…/pack/1573-zhizhka»
	const crumbs = {
		'@context': 'https://schema.org',
		'@type': 'BreadcrumbList',
		itemListElement: [
			{ '@type': 'ListItem', position: 1, name: 'Библиотека паков SIGame', item: `${originOf(canonical)}/` },
			{ '@type': 'ListItem', position: 2, name, item: canonical },
		],
	};

	return [data, crumbs]
		.map(item => `<script type="application/ld+json">${jsonForHtml(item)}</script>`)
		.join('\n\t');
}

/** Адрес сайта из канонической ссылки: она и так собрана из него же. */
const originOf = canonical => canonical.replace(/^(https?:\/\/[^/]+).*$/, '$1');

/**
 * JSON внутрь <script>. Закрывающий тег в строке значения оборвал бы сам скрипт
 * посреди разметки, а названия паков бывают любые: экранируем косую черту.
 */
const jsonForHtml = value => JSON.stringify(value).replace(/</g, '\\u003c');

/**
 * Что видно на странице пака до того, как отработает скрипт.
 *
 * Страницу рисует JS, то есть поисковику она приходит пустой — с одним словом
 * «Загрузка…». Google такие страницы всё же дорисовывает сам, но не сразу
 * и не всегда, а Яндекс не дорисовывает вовсе: тринадцать тысяч страниц паков
 * для него были тринадцатью тысячами пустышек с разными заголовками, и ровно
 * поэтому на «пак по Гарри Поттеру» сайт в выдаче не находился.
 *
 * Здесь стоит то же самое, что покажет карточка: название, авторы, о чём пак,
 * состав раундов с темами. Скрипт эту заготовку затирает первым же действием
 * (`box.textContent = ''` в web/pack.js), поэтому человек её не увидит вовсе —
 * ни мельканием, ни вторым описанием под настоящей карточкой.
 */
function packBody(pack) {
	const name = (pack.name ?? pack.fileName ?? '').trim() || 'Пак без названия';
	const parts = [`<h1>${escapeHtml(name)}</h1>`];

	if (pack.authors?.length > 0) {
		parts.push(`<p>Автор: ${escapeHtml(pack.authors.join(', '))}</p>`);
	}

	if (pack.summary) {
		parts.push(`<p>${escapeHtml(pack.summary)}</p>`);
	}

	const numbers = [
		pack.questionCount ? `${pack.questionCount} ${plural(pack.questionCount, 'вопрос', 'вопроса', 'вопросов')}` : null,
		pack.roundCount ? `${pack.roundCount} ${plural(pack.roundCount, 'раунд', 'раунда', 'раундов')}` : null,
		pack.themeCount ? `${pack.themeCount} ${plural(pack.themeCount, 'тема', 'темы', 'тем')}` : null,
		pack.stats?.levelName ? `сложность: ${pack.stats.levelName.toLowerCase()}` : null,
		pack.stats?.startedGames ? `игр: ${pack.stats.startedGames}` : null,
	].filter(Boolean);

	if (numbers.length > 0) {
		parts.push(`<p>${escapeHtml(numbers.join(', '))}</p>`);
	}

	// Темы раундов — единственный текст пака, написанный не сайтом, и именно
	// по нему пак находят: «пак про Гарри Поттера» — это тема, а не название
	const rounds = (pack.rounds ?? []).filter(round => round.themes?.length > 0);

	if (rounds.length > 0) {
		parts.push('<h2>Темы пака</h2>');

		for (const round of rounds) {
			parts.push(`<p><b>${escapeHtml(round.name)}</b>: `
				+ `${escapeHtml(round.themes.map(theme => theme.name).join(', '))}</p>`);
		}
	}

	if (pack.commentText) {
		parts.push(`<p>${escapeHtml(pack.commentText)}</p>`);
	}

	return parts.join('\n\t\t');
}

/**
 * Вёрстка страницы пака с подставленными заголовками. На вход идёт web/pack.html
 * как есть, на выход — она же, но с названием пака во вкладке, описанием для
 * поисковика, обложкой для тех мест, где ссылку разворачивают в карточку
 * (Discord, ВК, Telegram — а паками делятся именно там), разметкой Schema.org
 * и готовым текстом пака для тех, кто скриптов не выполняет.
 *
 * @param {string} html содержимое pack.html
 * @param {object} pack пак из toPackage
 * @param {string} origin адрес сайта: «https://firepacks.ru»
 */
export function injectPackMeta(html, pack, origin) {
	const title = packTitle(pack);
	const description = packDescription(pack);
	const canonical = `${origin}${packPath(pack.id, pack.name ?? pack.fileName)}`;
	const image = pack.logo ? `${origin}${pack.logo}` : null;

	const tags = [
		`<meta name="description" content="${escapeHtml(description)}">`,
		`<link rel="canonical" href="${escapeHtml(canonical)}">`,
		`<meta property="og:type" content="article">`,
		`<meta property="og:site_name" content="FirePacks">`,
		`<meta property="og:locale" content="ru_RU">`,
		`<meta property="og:title" content="${escapeHtml(title)}">`,
		`<meta property="og:description" content="${escapeHtml(description)}">`,
		`<meta property="og:url" content="${escapeHtml(canonical)}">`,
		image ? `<meta property="og:image" content="${escapeHtml(image)}">` : null,
		`<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">`,
		packSchema(pack, canonical, image),
	].filter(Boolean).join('\n\t');

	return html
		// Название сайта отделено чертой, а не тире, как на остальных страницах:
		// в самом заголовке тире уже есть («Жижка — пак SIGame от ГЫХ»), и второе
		// подряд читалось бы как продолжение той же мысли
		.replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(title)} | FirePacks</title>`)
		.replace('<!--pack-meta-->', tags)
		.replace('<!--pack-body-->', packBody(pack));
}

/**
 * Карта сайта. Без неё отдельные страницы паков поисковику взять неоткуда:
 * в выдаче библиотеки постраничность сделана кнопками, а не ссылками, и обойти
 * её ползая по ссылкам нельзя — дальше первых двух десятков паков поисковик
 * просто не попадёт.
 *
 * Дата последнего изменения — время сообщения ВК, из которого взят пак: другого
 * времени у пака нет, а без даты поисковик обходит карту целиком каждый раз.
 *
 * @param {Array} rows строки {id, name, vk_ts}
 */
export function buildSitemap(rows, origin) {
	// Когда библиотека менялась в последний раз — это время самого свежего пака
	// в ней. Без даты поисковик обходит главную наугад: то каждый день, то раз
	// в месяц, и появление сотни новых паков он замечает когда придётся.
	const newest = rows.reduce((latest, row) => (row.vk_ts > latest ? row.vk_ts : latest), 0);
	const day = value => new Date(value).toISOString().slice(0, 10);

	const urls = [
		`\t<url><loc>${escapeHtml(origin)}/</loc>`
			+ (newest ? `<lastmod>${day(newest)}</lastmod>` : '')
			+ `<changefreq>daily</changefreq><priority>1.0</priority></url>`,
		`\t<url><loc>${escapeHtml(origin)}/authors</loc><changefreq>weekly</changefreq><priority>0.6</priority></url>`,
	];

	for (const row of rows) {
		const date = row.vk_ts ? day(row.vk_ts) : null;

		urls.push(`\t<url><loc>${escapeHtml(origin)}${packPath(row.id, row.name)}</loc>`
			+ (date ? `<lastmod>${date}</lastmod>` : '')
			+ `<changefreq>monthly</changefreq><priority>0.8</priority></url>`);
	}

	return `<?xml version="1.0" encoding="UTF-8"?>\n`
		+ `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

/**
 * robots.txt. Собирается на ходу, а не лежит файлом, ровно ради последней строки:
 * адрес карты сайта в нём должен быть полным, а какой у сайта адрес, знает только
 * сам пришедший запрос.
 *
 * Личное и служебное закрыто: профиль у каждого свой и в выдаче ему делать нечего,
 * а /api/ — это не страницы вовсе.
 */
export function buildRobots(origin) {
	return `User-agent: *\n`
		+ `Allow: /\n`
		+ `Disallow: /api/\n`
		+ `Disallow: /auth/\n`
		+ `Disallow: /profile\n`
		+ `Disallow: /update\n`
		// Отбор фильтрами живёт в адресе (/?topic=anime&levels=3), и таких адресов
		// у одной и той же страницы бесконечно много. Запрещать их обход нельзя:
		// по ним же ходят ссылки с карточек и из профиля, и запрет читался бы как
		// «эта страница закрыта». Вместо запрета в самой странице стоит canonical
		// на «/» — то есть поисковику сказано не «не ходи», а «это всё одна и та же
		// страница». Яндексу то же самое говорится здесь, его же словом: параметры
		// отбора на содержимое страницы для него не влияют.
		+ `Clean-param: topic&levels&lang&tag&author&franchise&subject&sort&dir&page&pageSize`
		+ `&search&unrated&hidePlayed&onlyPlayed&onlyPlanned&login /\n\n`
		+ `Sitemap: ${origin}/sitemap.xml\n`;
}
