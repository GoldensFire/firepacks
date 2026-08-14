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
 * Вёрстка страницы пака с подставленными заголовками. На вход идёт web/pack.html
 * как есть, на выход — она же, но с названием пака во вкладке, описанием для
 * поисковика и обложкой для тех мест, где ссылку разворачивают в карточку
 * (Discord, ВК, Telegram — а паками делятся именно там).
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
		`<meta property="og:title" content="${escapeHtml(title)}">`,
		`<meta property="og:description" content="${escapeHtml(description)}">`,
		`<meta property="og:url" content="${escapeHtml(canonical)}">`,
		image ? `<meta property="og:image" content="${escapeHtml(image)}">` : null,
		`<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">`,
	].filter(Boolean).join('\n\t');

	return html
		// Название сайта отделено чертой, а не тире, как на остальных страницах:
		// в самом заголовке тире уже есть («Жижка — пак SIGame от ГЫХ»), и второе
		// подряд читалось бы как продолжение той же мысли
		.replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(title)} | FirePacks</title>`)
		.replace('<!--pack-meta-->', tags);
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
	const urls = [
		`\t<url><loc>${escapeHtml(origin)}/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>`,
		`\t<url><loc>${escapeHtml(origin)}/authors</loc><changefreq>weekly</changefreq></url>`,
	];

	for (const row of rows) {
		const date = row.vk_ts ? new Date(row.vk_ts).toISOString().slice(0, 10) : null;

		urls.push(`\t<url><loc>${escapeHtml(origin)}${packPath(row.id, row.name)}</loc>`
			+ (date ? `<lastmod>${date}</lastmod>` : '')
			+ `<changefreq>monthly</changefreq></url>`);
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
		+ `Disallow: /update\n\n`
		+ `Sitemap: ${origin}/sitemap.xml\n`;
}
