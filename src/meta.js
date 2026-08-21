// Шапки страниц и карта сайта — всё, что сайт говорит про себя не человеку,
// а поисковику.
//
// Страницы рисует тот же скрипт, что и карточки в выдаче, — то есть на языке
// поисковика они приходят пустыми, а название пака (или тематики) появляется
// в них потом, когда отработает JS. Заголовок вкладки и описание в выдаче так
// не получить: их читают из самой вёрстки, поэтому сервер подставляет их в неё
// до отправки. Это единственное место, где сайт вообще собирает HTML руками.
//
// Здесь три семейства страниц:
//
//   /pack/{номер}-{название}  — один пак (injectPackMeta);
//   /topic/{ярлык}            — все паки одной тематики: аниме, кино, музыка;
//   /subjects/{ключ}          — все паки про один предмет: Дота, Гарри Поттер.
//
// Двух последних раньше не было вовсе, и это была дыра ровно под те запросы,
// с которыми на сайт и приходят: «паки своя игра аниме» отвечала библиотека
// с отбором в адресе (/?topic=anime), а её же canonical говорил поисковику,
// что это всё одна и та же главная страница (см. buildRobots). То есть на
// «аниме» у сайта не было своей страницы — вообще ни одной.
//
// Общее для дома и Cloudflare нарочно: страницы там и там одни и те же,
// и разъехаться их заголовкам незачем (см. cf/src/index.js и src/server.js).

import { LEVELS, packNameOfTopic } from './settings.js';
import { packPath, subjectSlug, subjectPath, topicPath } from './slug.js';

/**
 * Как сайт называется. Отдельной строкой, а не десятком раз по вёрстке:
 * имя это уже менялось однажды (FirePacks → SIFirePacks), а адрес — нет,
 * и путать одно с другим не следует. Адрес живёт в wrangler.jsonc и меняется
 * переездом; здесь только имя, которое читают глазами.
 */
export const SITE_NAME = 'SIFirePacks';

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

/** «12 паков». Считается так часто, что просится отдельной строкой. */
const packsCount = count => `${count} ${plural(count, 'пак', 'пака', 'паков')}`;

/**
 * Как называется игра.
 *
 * Латинское «SIGame» — это то, как игра называется в файлах, в статистике
 * и в названии движка. Ищут её при этом и так, и кириллицей: «своя игра»,
 * «своей игры», «си гейм», «сигейм» — по Вебмастеру показы идут на все
 * написания сразу, а до сих пор в заголовках стояло только латинское.
 * Поэтому здесь оба, рядом и по-русски: не списком ключевых слов, а тем самым
 * оборотом, каким об игре и говорят, — «пак для «Своей игры» (SIGame)».
 */
const GAME = '«Своей игры» (SIGame)';

/**
 * То же самое, но одним написанием. Заголовок вкладки виден в выдаче не весь —
 * Google обрезает его примерно на шестом десятке знаков, — и полное «для «Своей
 * игры» (SIGame)» съедает пятую часть строки на одно только название игры.
 * Поэтому в заголовках кириллица стоит там, где она читается, а «SIGame»
 * приписывается в конец отдельным словом; в описании же, где места втрое
 * больше, идёт полное написание.
 */
const GAME_RU = '«Своей игры»';

/** Заголовок вкладки и строка выдачи: «Жижка — пак для «Своей игры» (SIGame) от ГЫХ». */
function packTitle(pack) {
	const name = (pack.name ?? pack.fileName ?? '').trim() || 'Пак без названия';
	const author = pack.authors?.[0];

	return `${name} — пак для ${GAME}${author ? ` от ${author}` : ''}`;
}

/**
 * Описание под ссылкой в поисковой выдаче. Собирается из того, что про пак
 * известно наверняка, и начинается с пересказа от нейросети, если он есть:
 * это единственная строка, которая отвечает на вопрос «о чём пак», словами.
 *
 * Второй кусок — что это вообще такое, и сказано это по-русски: «Аниме-пак
 * для «Своей игры»». Стоит он вторым, а не в конце, нарочно: описание
 * обрезается по длине, и до хвоста выдача доходит не всегда, а «пак для Своей
 * игры» — ровно то, что человек набирал.
 *
 * Ярлык здесь знает и про солянки. Раньше не знал: в базе у них стоит «mixed»,
 * а в списке ярлыков такого ключа не было — и шесть тысяч паков из одиннадцати
 * не говорили о себе в выдаче ничего, кроме чисел (см. packNameOfTopic).
 *
 * Длина держится в пределах двух с небольшим сотен знаков: длиннее выдача всё
 * равно обрежет, и обрежет посередине слова.
 */
function packDescription(pack) {
	const parts = [];

	if (pack.summary) {
		parts.push(pack.summary.trim().replace(/\s+/g, ' '));
	}

	const packName = packNameOfTopic(pack.primaryTopic);

	parts.push(packName ? `${packName} для ${GAME}` : `Пак для ${GAME}`);

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

	parts.push('скачать .siq или играть онлайн');

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
	const origin = originOf(canonical);

	const data = {
		'@context': 'https://schema.org',
		'@type': 'CreativeWork',
		name,
		url: canonical,
		description: packDescription(pack),
		inLanguage: pack.language ?? 'ru',
		genre: packNameOfTopic(pack.primaryTopic) ?? undefined,
		image: image ?? undefined,
		datePublished: pack.vkTs ? new Date(pack.vkTs).toISOString().slice(0, 10) : undefined,
		author: pack.authors?.length > 0
			? pack.authors.map(author => ({ '@type': 'Person', name: author }))
			: undefined,
		isPartOf: { '@type': 'CollectionPage', name: SITE_NAME, url: `${origin}/` },
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
	// адреса — «SIFirePacks › Аниме-паки › Жижка» вместо «firepacks…/pack/1573».
	//
	// Средняя ступень появилась вместе со страницами тематик: раньше пути
	// не было вовсе — библиотека и сразу пак, — а теперь у пака есть свой
	// раздел, и путь в него настоящий, ссылкой.
	const section = TOPIC_PAGES[pack.primaryTopic];

	const crumbs = breadcrumbs([
		{ name: `Библиотека паков для ${GAME}`, url: `${origin}/` },
		...(section ? [{ name: section.title, url: `${origin}${topicPath(pack.primaryTopic)}` }] : []),
		{ name, url: canonical },
	]);

	return [data, crumbs]
		.map(item => `<script type="application/ld+json">${jsonForHtml(item)}</script>`)
		.join('\n\t');
}

/** Путь под ссылкой в выдаче: «SIFirePacks › Аниме-паки › Наруто». */
function breadcrumbs(trail) {
	return {
		'@context': 'https://schema.org',
		'@type': 'BreadcrumbList',
		itemListElement: trail.map((step, index) => ({
			'@type': 'ListItem',
			position: index + 1,
			name: step.name,
			item: step.url,
		})),
	};
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

	// Первой же строкой — что это такое, словами человека, а не ярлыком:
	// «Аниме-пак для «Своей игры» (SIGame)». Тому, кто скриптов не выполняет,
	// это единственное объяснение, чем страница вообще является
	const packName = packNameOfTopic(pack.primaryTopic);
	const section = TOPIC_PAGES[pack.primaryTopic];

	parts.push(`<p>${escapeHtml(packName ? `${packName} для ${GAME}` : `Пак для ${GAME}`)}</p>`);

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

	// Дорога наверх, в свой раздел. Ссылка настоящая и нужна не человеку —
	// он до заготовки не доживёт, — а поисковику: страница пака перестаёт быть
	// тупиком, из которого ведёт только карта сайта.
	if (section) {
		parts.push(`<p><a href="${escapeHtml(topicPath(pack.primaryTopic))}">`
			+ `${escapeHtml(`${section.title} для ${GAME}`)}</a></p>`);
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
 * @param {string} origin адрес сайта, каким его видит пришедший запрос
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
		`<meta property="og:site_name" content="${SITE_NAME}">`,
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
		// в самом заголовке тире уже есть («Жижка — пак для Своей игры»), и второе
		// подряд читалось бы как продолжение той же мысли
		.replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(title)} | ${SITE_NAME}</title>`)
		.replace('<!--pack-meta-->', tags)
		.replace('<!--pack-body-->', packBody(pack));
}

// ————— страницы разделов: тематики и типы паков —————

/**
 * Тематики, у которых есть своя страница, и как о них говорить.
 *
 * Ключ — то же самое, что лежит в primary_topic и уходит в отбор выдачи
 * (?topic=anime): второго набора ключей заводить незачем. Порядок здесь —
 * порядок ссылок в дорожке разделов, и он не по алфавиту, а по тому, чего ищут
 * больше: аниме, игры, кино и музыка идут первыми.
 *
 * Что в полях:
 *   title — как называется раздел: «Паки по аниме». Из него же собирается
 *           заголовок вкладки;
 *   also  — как эти же паки зовут иначе: «мультпак», «солянка». Тем же словом
 *           их и набирают;
 *   about — чем эти паки набиты, коротко: это уходит в описание для выдачи,
 *           а там на всё про всё полторы сотни знаков;
 *   more  — то же самое, но с примерами, для первого абзаца самой страницы,
 *           где места вдоволь.
 *
 * Две последние строки — единственное, что отличает страницу аниме-паков
 * от страницы кинопаков. Без них десять страниц были бы одним и тем же текстом
 * с подменённым словом, а это ровно то, что поисковик зовёт пустышками
 * и в выдачу не пускает.
 *
 * Ярлыка «unknown» здесь нет нарочно: «паки, которых разметка ещё не касалась» —
 * это состояние работы, а не раздел библиотеки, и страницы ему не полагается.
 */
export const TOPIC_PAGES = {
	anime: {
		title: 'Паки по аниме',
		also: 'аниме-паки',
		about: 'персонажи, сюжеты, студии и опенинги',
		more: 'От «Наруто», «Ван-Пис» и «Атаки титанов» до свежих сезонов; '
			+ 'угадать опенинг, вспомнить студию, назвать героя по кадру.',
	},
	games: {
		title: 'Паки по играм',
		also: 'игропаки',
		about: 'видеоигры: персонажи, механики, предметы',
		more: 'Dota, Counter-Strike, Minecraft, World of Warcraft, инди и классика; '
			+ 'предметы, способности, карты и внутриигровые байки.',
	},
	movies: {
		title: 'Паки по кино и сериалам',
		also: 'кинопаки',
		about: 'фильмы и сериалы: кадры, цитаты, актёры',
		more: 'От классики до последних премьер: узнать фильм по кадру, '
			+ 'вспомнить режиссёра, продолжить цитату.',
	},
	music: {
		title: 'Музыкальные паки',
		also: 'музпаки, паки с музыкой',
		about: 'вопросы на слух: треки, исполнители, саундтреки',
		more: 'Такие вопросы отгадывают ушами, а не глазами: отрывок трека, '
			+ 'саундтрек к фильму, опенинг, каверы и живые записи. Паку нужен звук, '
			+ 'и это его главное свойство.',
	},
	cartoons: {
		title: 'Паки по мультфильмам',
		also: 'мультпаки',
		about: 'мультфильмы и мультсериалы: герои, кадры, песни',
		more: 'От советской классики и Disney до «Гравити Фолз» и «Рика и Морти».',
	},
	mixed: {
		title: 'Паки-солянки обо всём',
		also: 'солянки, паки на эрудицию',
		about: 'обо всём сразу: история, наука, мемы, эрудиция',
		more: 'История, наука, география, знаменитости, мемы и быт в одном паке. '
			+ 'Такие собирают на эрудицию и на компанию, где вкусы у всех разные, — '
			+ 'это самый частый пак в библиотеке.',
	},
	sport: {
		title: 'Паки по спорту',
		also: 'спортпаки',
		about: 'футбол, хоккей, киберспорт: клубы, игроки, рекорды',
		more: 'Футбол, хоккей, баскетбол, киберспорт и олимпийские виды: '
			+ 'клубы, игроки, рекорды и памятные матчи.',
	},
	books: {
		title: 'Паки по книгам',
		also: 'книгапаки',
		about: 'книги и писатели: сюжеты, герои, цитаты',
		more: 'Классика, фантастика и фэнтези: узнать книгу по первой строчке, '
			+ 'вспомнить автора, назвать героя.',
	},
	manga: {
		title: 'Паки по манге и манхве',
		also: 'манга-паки',
		about: 'манга, манхва и маньхуа: главы, авторы, рисовка',
		more: 'Отдельно от аниме нарочно: тут спрашивают про сами тома и главы, '
			+ 'а не про экранизацию.',
	},
	comics: {
		title: 'Паки по комиксам',
		also: 'комикс-паки',
		about: 'комиксы: Marvel, DC, герои и злодеи',
		more: 'Marvel, DC и авторские серии: происхождение героев, злодеи, '
			+ 'кроссоверы и обложки.',
	},
};

/** Ключи тематик со страницами, в том порядке, в каком они стоят в списке. */
export const TOPIC_PAGE_KEYS = Object.keys(TOPIC_PAGES);

/**
 * С какого числа паков у типа заводится своя страница в карте сайта.
 *
 * Тип, у которого пак ровно один, страницей быть не перестаёт — по прямой
 * ссылке она откроется, — но звать на неё поисковика незачем: весь её текст
 * это название одного пака, у которого своя страница уже есть. Две такие
 * страницы в выдаче — это одна и та же страница дважды, и поисковик считает
 * такое не находкой, а сором. Поэтому в карту сайта они не попадают
 * и просят себя не показывать (см. noindex в injectLandingMeta).
 */
const SUBJECT_PAGE_MIN = 2;

/**
 * Типы паков, у которых есть своя страница: все, чей ключ вообще ложится
 * в адрес. Ключ считает src/subject.js, и у предмета, написанного целиком
 * не латиницей и не цифрами, он в адрес не ложится — таких единицы, и жить
 * им по-прежнему в общем списке /subjects.
 *
 * @param {Array} groups ответ subjectGroups: {name, key, count, names}
 */
export function subjectPages(groups) {
	const seen = new Set();
	const pages = [];

	for (const group of groups ?? []) {
		const slug = subjectSlug(group.key);

		// Двух групп с одним адресом быть не должно: открывалась бы всегда
		// первая, а вторая молча пропадала. Ключи сведены к латинице и словам
		// через пробел, так что случается это разве что на чужих алфавитах.
		if (!slug || seen.has(slug)) {
			continue;
		}

		seen.add(slug);
		pages.push({ ...group, slug });
	}

	return pages;
}

/** Группа по куску адреса. Ничего не нашлось — значит, такой страницы нет. */
export function subjectBySlug(groups, slug) {
	return subjectPages(groups).find(page => page.slug === slug) ?? null;
}

/**
 * Страница тематики: что писать в шапке и что показать до скриптов.
 *
 * @param {string} key ярлык тематики, он же отбор выдачи
 * @param {number} count сколько всего таких паков в базе
 * @param {Array} packs верхушка списка — то, что попадёт в текст страницы
 */
export function topicLanding(key, count, packs) {
	const about = TOPIC_PAGES[key];

	if (!about) {
		return null;
	}

	return {
		kind: 'topic',
		key,
		heading: `${about.title} для ${GAME}`,
		// Число в заголовке вкладки — не украшение: в выдаче оно стоит рядом
		// с названием и отвечает на невысказанное «а сколько их у вас», по
		// которому и выбирают, куда нажать
		title: `${about.title} для ${GAME_RU} — ${packsCount(count)} SIGame`,
		description: `${about.title} для ${GAME}: ${count} `
			+ `${plural(count, 'пакет', 'пакета', 'пакетов')} вопросов — ${about.about}. `
			+ `Скачать .siq или играть онлайн.`,
		intro: `Здесь собраны ${about.also} из библиотеки — ${about.about}. ${about.more} `
			+ `Всего таких паков ${count}; у каждого посчитана сложность по статистике игр.`,
		count,
		packs,
		// Отбор, которым эту же выдачу покажет библиотека. Он же уезжает
		// в браузер, и им же грузится настоящий список карточек
		query: `topic=${encodeURIComponent(key)}`,
		path: topicPath(key),
		trail: [{ name: about.title, path: topicPath(key) }],
	};
}

/**
 * Страница типа пака: «Паки по теме «Дота»», «Паки по теме «Гарри Поттер»».
 *
 * @param {object} page группа из subjectPages
 * @param {Array} packs верхушка списка
 * @param {number} share доля пака, с которой он считается паком про это
 */
export function subjectLanding(page, packs, share) {
	const { name, count } = page;
	const percent = Math.round((share ?? 0.5) * 100);

	return {
		kind: 'subject',
		key: page.key,
		heading: `Паки по теме «${name}» для ${GAME}`,
		title: `Паки по теме «${name}» для ${GAME_RU} — ${packsCount(count)}`,
		description: `${packsCount(count)} для ${GAME} целиком по теме «${name}»: `
			+ `состав раундов, число вопросов, сложность по статистике. `
			+ `Скачать .siq или играть онлайн.`,
		intro: `Паки, у которых тема «${name}» занимает не меньше ${percent}% вопросов, — `
			+ `то есть пак про это, а не пак, где это разок упомянуто. `
			+ `Всего таких ${packsCount(count)}.`,
		count,
		packs,
		// Отбирается по названию группы, а не по ключу: сведение написаний
		// («Дота» и «Дота 2» — одно и то же) живёт на стороне выдачи
		// (см. subjectMatches в src/subject.js)
		query: `subject=${encodeURIComponent(name)}`,
		path: subjectPath(page.key),
		// Своей страницы в выдаче не просит тот, за кем стоит один-единственный
		// пак: у него уже есть страница, и вторая была бы её двойником
		noindex: count < SUBJECT_PAGE_MIN,
		trail: [
			{ name: 'Паки целиком про одно', path: '/subjects' },
			{ name, path: subjectPath(page.key) },
		],
	};
}

/**
 * Топ пакетов. Страница была и раньше, но приходила поисковику пустой — как
 * и всё, что рисует скрипт. Запросов «лучшие паки для своей игры» и «топ паков
 * sigame» при этом хватает, а отвечать на них было нечем.
 */
export function topLanding(packs) {
	return {
		kind: 'top',
		key: 'top',
		heading: `Лучшие паки для ${GAME}`,
		title: `Лучшие паки для ${GAME_RU} — топ паков SIGame за 3 месяца`,
		description: `Лучшие паки для ${GAME}: самые играемые из выложенных за последние `
			+ `три месяца — по числу начатых игр из статистики SIGame. `
			+ `Скачать .siq или играть онлайн.`,
		intro: `Паки, выложенные за последние три месяца, самые играемые сверху. `
			+ `Число игр берётся из статистики SIGame и считается за всё время: окна `
			+ `подсчёта у неё нет, и три месяца отбирают паки, а не игры.`,
		count: packs.length,
		packs,
		// Своего отбора у топа нет: страница сама знает, что и как показать,
		// и вкладки категорий на ней рисует её собственный скрипт (web/top.js)
		query: '',
		path: '/top',
		trail: [{ name: 'Топ пакетов', path: '/top' }],
	};
}

/** Строка про один пак в списке раздела: «Название — автор, 120 вопросов, сложность». */
function packLine(pack, origin) {
	const name = (pack.name ?? pack.fileName ?? '').trim() || 'Пак без названия';

	const about = [
		pack.authors?.length > 0 ? pack.authors.join(', ') : null,
		pack.questionCount
			? `${pack.questionCount} ${plural(pack.questionCount, 'вопрос', 'вопроса', 'вопросов')}`
			: null,
		pack.levelName ? `сложность: ${pack.levelName.toLowerCase()}` : null,
		pack.startedGames ? `игр: ${pack.startedGames}` : null,
	].filter(Boolean);

	const href = `${origin}${packPath(pack.id, pack.name ?? pack.fileName)}`;

	return `<li><a href="${escapeHtml(href)}">${escapeHtml(name)}</a>`
		+ (about.length > 0 ? ` — ${escapeHtml(about.join(', '))}` : '')
		+ `</li>`;
}

/**
 * Что видно на странице раздела до того, как отработает скрипт: заголовок,
 * абзац про раздел, список паков ссылками и дорожка в соседние разделы.
 *
 * Список здесь не для красоты. Постраничность выдачи сделана кнопками, а не
 * ссылками, и попасть со страницы раздела на страницу пака поисковику было
 * нечем, кроме карты сайта; теперь у каждого раздела два десятка настоящих
 * ссылок на паки, а у каждого пака — путь наверх, в свой раздел.
 *
 * Скрипт эту заготовку затирает первым же действием (см. web/landing.js),
 * поэтому человек её не увидит вовсе.
 */
function landingBody(landing, origin) {
	// У топа своя вёрстка, и заголовок с подписью в ней уже стоят — своими,
	// написанными в самом web/top.html. Второй заголовок на странице был бы
	// не мелочью: два <h1> подряд поисковик читает как «страница про две
	// разные вещи», а страница про одну.
	const parts = landing.kind === 'top' ? [] : [
		`<h1>${escapeHtml(landing.heading)}</h1>`,
		`<p>${escapeHtml(landing.intro)}</p>`,
	];

	if (landing.packs?.length > 0) {
		parts.push(`<h2>${escapeHtml(landing.kind === 'top' ? 'Самые играемые' : 'Самые играемые паки раздела')}</h2>`);
		parts.push(`<ul>\n\t\t\t${landing.packs.map(pack => packLine(pack, origin)).join('\n\t\t\t')}\n\t\t</ul>`);
	} else {
		parts.push('<p>Паков в этом разделе пока нет.</p>');
	}

	// Ссылка в библиотеку с уже поставленным отбором: раздел показывает верхушку,
	// а всё остальное — там, со всеми сортировками и фильтрами
	if (landing.query && landing.count > (landing.packs?.length ?? 0)) {
		parts.push(`<p><a href="${escapeHtml(`${origin}/?${landing.query}`)}">`
			+ `Все ${packsCount(landing.count)} в библиотеке</a></p>`);
	}

	parts.push('<h2>Другие разделы библиотеки</h2>');
	parts.push(`<ul>\n\t\t\t${sectionLinks(landing, origin).join('\n\t\t\t')}\n\t\t</ul>`);

	return parts.join('\n\t\t');
}

/**
 * Дорожка в соседние разделы. Стоит на каждой странице раздела и решает
 * ровно одну задачу: страницы тематик не висят в пустоте, куда добраться можно
 * только из карты сайта. Из любой из них поисковик попадает в остальные девять,
 * в список типов паков и в топ.
 */
function sectionLinks(landing, origin) {
	const links = TOPIC_PAGE_KEYS
		.filter(key => !(landing.kind === 'topic' && key === landing.key))
		.map(key => ({ href: `${origin}${topicPath(key)}`, text: `${TOPIC_PAGES[key].title} для ${GAME}` }));

	links.push({ href: `${origin}/subjects`, text: 'Паки целиком про одно: Дота, Гарри Поттер, футбол' });

	if (landing.kind !== 'top') {
		links.push({ href: `${origin}/top`, text: `Топ паков для ${GAME} за 3 месяца` });
	}

	links.push({ href: `${origin}/`, text: 'Вся библиотека паков' });

	return links.map(link => `<li><a href="${escapeHtml(link.href)}">${escapeHtml(link.text)}</a></li>`);
}

/** Разметка Schema.org раздела: что это за список и что в нём лежит. */
function landingSchema(landing, canonical, origin) {
	const data = {
		'@context': 'https://schema.org',
		'@type': 'CollectionPage',
		name: landing.heading,
		url: canonical,
		description: landing.description,
		inLanguage: 'ru',
		isPartOf: { '@type': 'WebSite', name: SITE_NAME, url: `${origin}/` },
		mainEntity: {
			'@type': 'ItemList',
			numberOfItems: landing.count,
			itemListElement: (landing.packs ?? []).map((pack, index) => ({
				'@type': 'ListItem',
				position: index + 1,
				url: `${origin}${packPath(pack.id, pack.name ?? pack.fileName)}`,
				name: (pack.name ?? pack.fileName ?? '').trim() || 'Пак без названия',
			})),
		},
	};

	const crumbs = breadcrumbs([
		{ name: `Библиотека паков для ${GAME}`, url: `${origin}/` },
		...landing.trail.map(step => ({ name: step.name, url: `${origin}${step.path}` })),
	]);

	return [data, crumbs]
		.map(item => `<script type="application/ld+json">${jsonForHtml(item)}</script>`)
		.join('\n\t');
}

/**
 * Вёрстка страницы раздела с подставленными заголовками. На вход идёт
 * web/landing.html как есть, на выход — она же, но со своим заголовком вкладки,
 * своим описанием и своим каноническим адресом.
 *
 * Канонический адрес здесь — сама страница, и это главное отличие от того,
 * как раздел жил раньше. Отбор в адресе библиотеки (/?topic=anime) canonical
 * отсылал на «/», то есть на языке поисковика все отборы были одной и той же
 * страницей; у /topic/anime свой адрес, свой заголовок и свой текст — она своя.
 *
 * @param {string} html содержимое landing.html
 * @param {object} landing ответ topicLanding / subjectLanding / topLanding
 * @param {string} origin адрес сайта, каким его видит пришедший запрос
 */
export function injectLandingMeta(html, landing, origin) {
	const canonical = `${origin}${landing.path}`;

	const tags = [
		`<meta name="description" content="${escapeHtml(landing.description)}">`,
		`<link rel="canonical" href="${escapeHtml(canonical)}">`,
		// Страница за одним-единственным паком — двойник его собственной страницы,
		// и просить её показывать не за что. «follow» при этом остаётся: ссылки
		// с неё вести никуда не перестают
		landing.noindex ? `<meta name="robots" content="noindex, follow">` : null,
		`<meta property="og:type" content="website">`,
		`<meta property="og:site_name" content="${SITE_NAME}">`,
		`<meta property="og:locale" content="ru_RU">`,
		`<meta property="og:title" content="${escapeHtml(landing.heading)}">`,
		`<meta property="og:description" content="${escapeHtml(landing.description)}">`,
		`<meta property="og:url" content="${escapeHtml(canonical)}">`,
		`<meta name="twitter:card" content="summary">`,
		landingSchema(landing, canonical, origin),
	].filter(Boolean).join('\n\t');

	// Что за раздел открыт — скрипту. Разобрать это из адреса он не сможет:
	// у типа пака в адресе стоит ключ («garri-potter»), а отбор выдачи идёт
	// по названию («Гарри Поттер»), и перевод одного в другое знает только
	// тот, у кого на руках весь список типов, — то есть сервер.
	const state = {
		kind: landing.kind,
		key: landing.key,
		heading: landing.heading,
		hint: landing.intro,
		count: landing.count,
		query: landing.query,
	};

	return html
		.replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(landing.title)} | ${SITE_NAME}</title>`)
		.replace('<!--landing-meta-->', tags)
		.replace('<!--landing-state-->',
			`<script id="landingState" type="application/json">${jsonForHtml(state)}</script>`)
		.replace('<!--landing-body-->', landingBody(landing, origin));
}

/**
 * Первая страница выдачи и настройки — прямо в вёрстке библиотеки.
 *
 * Не разметка для поисковика, а именно данные: список паков рисует та же самая
 * карточка, что и всегда (см. web/card.js), и второй, серверной, её копии здесь
 * нет нарочно. Была бы — скрипт всё равно перерисовал бы список своей, уже
 * с отметками и подсказками, и браузер посчитал бы «страница показалась» по этой
 * второй, поздней отрисовке. Ровно это происходит на страницах разделов, где
 * серверная заготовка есть: она затирается первым же действием скрипта
 * (см. landingBody выше и web/landing.js).
 *
 * Здесь наоборот: рисует по-прежнему только скрипт, и рисует один раз — но
 * рисовать ему есть чем сразу, без похода на сервер.
 *
 * Кладётся это не всем: заготовка общая, лежит в общем кэше и посчитана
 * без хозяина — значит, годится только гостю и только без отбора в адресе
 * (см. cf/src/index.js).
 *
 * Мест в странице два, и это не прихоть. Сами данные — в самом конце: полторы
 * сотни килобайт разметки браузер разбирает по порядку, и лежи они выше, шапка
 * с фильтрами ждали бы, пока он их дочитает. А метка — в шапке страницы, потому
 * что решать «ходить за выдачей или нет» надо там же, где стоит начало ходки,
 * то есть до всей вёрстки.
 *
 * @param {string} html содержимое index.html
 * @param {object} boot {packages, facets} — ровно то же самое, что отдают
 *   /api/packages и /api/facets, слово в слово
 */
export function injectHomeBoot(html, boot) {
	return html
		.replace('<!--home-boot-mark-->', '<script>window.homeBoot=1</script>')
		.replace('<!--home-boot-->',
			`<script id="homeBoot" type="application/json">${jsonForHtml(boot)}</script>`);
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
 * @param {string} origin адрес сайта
 * @param {object} sections что на сайте есть кроме паков: topics — ярлыки
 *   тематик, у которых нашлись паки; subjects — типы паков из subjectPages
 */
export function buildSitemap(rows, origin, sections = {}) {
	// Когда библиотека менялась в последний раз — это время самого свежего пака
	// в ней. Без даты поисковик обходит главную наугад: то каждый день, то раз
	// в месяц, и появление сотни новых паков он замечает когда придётся.
	const newest = rows.reduce((latest, row) => (row.vk_ts > latest ? row.vk_ts : latest), 0);
	const day = value => new Date(value).toISOString().slice(0, 10);

	// Разделы меняются вместе с библиотекой и ровно тогда же: новый пак —
	// новая строка в своём разделе. Своей даты у них нет, и брать её больше
	// неоткуда, чем у самого свежего пака.
	const stamp = newest ? `<lastmod>${day(newest)}</lastmod>` : '';

	const urls = [
		`\t<url><loc>${escapeHtml(origin)}/</loc>${stamp}`
			+ `<changefreq>daily</changefreq><priority>1.0</priority></url>`,
		`\t<url><loc>${escapeHtml(origin)}/authors</loc><changefreq>weekly</changefreq><priority>0.6</priority></url>`,
		// Топ пакетов меняется чаще топа авторов: он считается за три месяца,
		// и каждая новая неделя выбрасывает из него верхнюю строчку
		`\t<url><loc>${escapeHtml(origin)}/top</loc>${stamp}<changefreq>weekly</changefreq><priority>0.7</priority></url>`,
		// Список тем, которым посвящён целый пак. Меняется он медленно — новая
		// строка появляется, когда про что-то соберут второй пак, — но искать
		// «пак по Цивилизации» приходят именно поисковиком
		`\t<url><loc>${escapeHtml(origin)}/subjects</loc><changefreq>weekly</changefreq><priority>0.6</priority></url>`,
	];

	// Страницы тематик стоят сразу после главной и выше отдельных паков нарочно:
	// это те самые страницы, на которые приходят с «паки своя игра аниме», и
	// поисковику стоит знать, что на сайте они главнее любого отдельного пака
	for (const key of TOPIC_PAGE_KEYS) {
		if (!(sections.topics ?? []).includes(key)) {
			continue;
		}

		urls.push(`\t<url><loc>${escapeHtml(origin)}${topicPath(key)}</loc>${stamp}`
			+ `<changefreq>daily</changefreq><priority>0.9</priority></url>`);
	}

	for (const page of sections.subjects ?? []) {
		// Тип с одним паком в карту не зовём: см. SUBJECT_PAGE_MIN
		if (page.count < SUBJECT_PAGE_MIN) {
			continue;
		}

		urls.push(`\t<url><loc>${escapeHtml(origin)}${subjectPath(page.key)}</loc>${stamp}`
			+ `<changefreq>weekly</changefreq><priority>0.7</priority></url>`);
	}

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
		// Список слов для поиска: семь мегабайт, читать его человеку незачем,
		// а обходчикам — тем более (см. writeSearchIndex в scripts/build-web.js)
		+ `Disallow: /search-index.txt\n`
		// Отбор фильтрами живёт в адресе (/?topic=anime&levels=3), и таких адресов
		// у одной и той же страницы бесконечно много. Запрещать их обход нельзя:
		// по ним же ходят ссылки с карточек и из профиля, и запрет читался бы как
		// «эта страница закрыта». Вместо запрета в самой странице стоит canonical
		// на «/» — то есть поисковику сказано не «не ходи», а «это всё одна и та же
		// страница». Яндексу то же самое говорится здесь, его же словом: параметры
		// отбора на содержимое страницы для него не влияют.
		//
		// Страниц разделов это не касается вовсе, и в этом весь их смысл:
		// у /topic/anime и /subjects/dota адрес без параметров, свой заголовок
		// и свой canonical на самих себя (см. injectLandingMeta).
		+ `Clean-param: topic&levels&lang&tag&author&franchise&subject&sort&dir&page&pageSize`
		+ `&search&unrated&hidePlayed&onlyPlayed&onlyPlanned&hidePlanned&login /\n\n`
		+ `Sitemap: ${origin}/sitemap.xml\n`;
}
