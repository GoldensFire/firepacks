// Сайт на Cloudflare Workers: то же API, что у домашнего src/server.js, поверх
// той же базы, переехавшей в D1.
//
// Чего здесь нет и не будет — сборки базы. Индексатор ходит в ВК и Gemini,
// разбирает архивы паков и пишет в базу часами; на чужом адресе ему нечего
// делать, а открытая кнопка «обновить», дёргающая чужие ключи, там просто
// опасна. Поэтому база собирается дома обычным запуском и уезжает сюда готовой
// (см. scripts/export-d1.js), а всё, что начинается с /api/update/, отвечает
// отказом. Дома это тот же режим, что FIREPACKS_READONLY=1.
//
// Вёрстку, скрипты и обложки Worker не отдаёт вовсе: их раздаёт сам Cloudflare
// из cf/public, не будя этот код. Сюда попадает только то, что не нашлось
// в статике, — то есть /api/… и /auth/….

import {
	listPackages, getPackage, getFacets, getSubjects, getTopAuthors, getProfile, listSitemap,
	setPlayed, setPlayedKeys, isPlayedPack, playedCount,
	setPlanned, setPlannedKeys, plannedCount,
	matchList, namePacks, landingPacks, listSubjectGroups,
} from './library.js';

import { settings } from '../../src/settings.js';
import { packIdFromPath, topicKeyFromPath, subjectSlugFromPath } from '../../src/slug.js';

import {
	injectPackMeta, injectLandingMeta, injectHomeBoot, buildSitemap, buildRobots,
	TOPIC_PAGES, TOPIC_PAGE_KEYS, subjectPages, subjectBySlug,
	topicLanding, subjectLanding, topLanding,
} from '../../src/meta.js';

import {
	hasDiscord, currentUser, startLogin, finishLogin, logout,
	rate, setBlacklisted, listBlacklist, SESSION_COOKIE,
} from './account.js';

/**
 * Ответы, одинаковые для всех, кто не вошёл, — выдача и настройки. Их держит
 * у себя сам Cloudflare, и следующий такой же запрос до этого кода не доходит
 * вовсе: ни Worker, ни база не тревожатся.
 *
 * Зачем это поверх памяти изолята. Изолятов много, живут они недолго и заводятся
 * заново в каждом городе, откуда пришёл посетитель, — а на редко посещаемом сайте
 * почти каждый гость попадает в свежий, пустой. То есть счёт «найдено» и числа
 * сложностей, которые приходится считать по всей отобранной части базы,
 * пересчитывались бы почти на каждое открытие страницы. У D1 прочитанные строки —
 * расход по тарифу, и на пятнадцати тысячах паков именно они, а не число
 * обращений, кончались бы первыми. Общий кэш складывает это в один пересчёт
 * на город раз в пять минут.
 *
 * Пять минут, а не час: база меняется ночью, но выложить её могут и днём,
 * и ждать полчаса, пока сайт заметит новые паки, никто не должен.
 */
const PUBLIC_TTL = 300;

/** Что вообще можно так отдавать: только чтение и только общее. */
const CACHEABLE = new Set(['/api/packages', '/api/facets', '/api/subjects', '/api/authors', '/api/package']);

/**
 * Карта сайта — самый дорогой запрос, какой тут есть: она читает все паки разом.
 * Меняется она не чаще, чем заливается база, то есть раз в ночь, и платить
 * за неё каждым приходом поисковика не за что.
 */
const SITEMAP_TTL = 86400;

/**
 * Сколько паков раздела попадает в саму страницу.
 *
 * Два десятка — это ровно та мера, при которой список остаётся списком: он
 * говорит, что в разделе есть, и даёт поисковику два десятка настоящих ссылок
 * на паки, а всё остальное лежит в библиотеке, куда со страницы ведёт ссылка.
 * Больше не нужно ни человеку (он всё равно уйдёт в библиотеку с фильтрами),
 * ни поисковику — сотня ссылок на странице весит больше, чем стоит.
 */
const LANDING_SIZE = 24;

/**
 * Сколько готовая страница раздела лежит в кэше Cloudflare.
 *
 * Час, а не пять минут, как у выдачи: страница раздела — самый дорогой по базе
 * запрос из тех, что открывают руками. Порядок в ней по числу игр, а число игр
 * лежит не в указателе, и чтобы отдать двадцать четыре строки, база перебирает
 * все паки раздела — у солянок это семь тысяч. Меняется же список медленно:
 * новый пак попадает в верхушку раздела не в тот час, когда появился, а когда
 * его начнут играть. Час устаревания тут не стоит ничего.
 */
const LANDING_TTL = 3600;

/**
 * Какую выдачу видит тот, кто открыл библиотеку и ничего не выбирал.
 *
 * Слово в слово то же, что складывает buildQuery в web/app.js для нетронутых
 * фильтров: те же сортировка, страница и размер страницы, те же «показывать
 * паки без оценки» и «прятать сыгранное». Расхождение здесь стоило бы дорого
 * и молча — заготовка в странице показывала бы одно, а первая же смена фильтра
 * подменяла бы список другим.
 *
 * «Прятать сыгранное» гостю ничего не прячет: отметки его лежат в самом
 * браузере, и база о них не знает (см. renderPlayedFilters там же). Строка
 * от этого не меняется — она обязана совпасть с той, что составит скрипт.
 */
const HOME_QUERY = 'sort=added&dir=desc&page=1&pageSize=24&unrated=1&hidePlayed=1';

/**
 * Файлы, которыми Google и Яндекс проверяют, что сайт наш.
 *
 * Лежат они в статике и уезжают наверх байт в байт (см. RAW в
 * scripts/build-web.js), но досюда доходить не должны были вовсе — а доходят,
 * и вот почему. Cloudflare раздаёт статику со снятым «.html»: по /subjects он
 * отдаёт subjects.html, и это ровно то, на чём держатся адреса страниц сайта.
 * Правило это обоюдное — спросили с расширением, получите отсылку на адрес
 * без него, — и на этих двух файлах оно оборачивается против нас: поисковик
 * приходит ровно по тому адресу, который сам же и выдал, с «.html» на конце,
 * а получает не файл, а 307.
 *
 * Содержимое по отсылке правильное, и подтверждение однажды прошло. Но Google
 * проверяет права заново и время от времени, а отсылку вместо файла считает
 * основанием их снять — и снятые права означают потерянный доступ к Search
 * Console вместе со всей статистикой запросов. Поэтому эти два адреса отвечают
 * сами: тот же самый файл, но сразу и с кодом 200.
 *
 * Имена не выдуманы и переименованию не подлежат: у Google это имя выдано им
 * самим, у Яндекса — «yandex_<код>.html» (см. тот же RAW в build-web.js).
 * Названы они и здесь, и в run_worker_first (см. wrangler.jsonc): без второго
 * места запрос до сюда бы не дошёл — Cloudflare ответил бы отсылкой раньше.
 */
const VERIFY = new Set(['/googlec52a37e47b9088a6.html', '/yandex_42c0743c2b5d2eb6.html']);

/**
 * Вошёл ли пришедший — по печенью, без похода в базу. Именно этим решается,
 * можно ли брать общий ответ и класть в него свой: у вошедшего в выдаче
 * его собственное — своя оценка, свои отметки, свой чёрный список, — и общая
 * полка тут означала бы чужие отметки у чужого человека.
 */
const anonymous = request => !(request.headers.get('Cookie') ?? '').includes(`${SESSION_COOKIE}=`);

function json(data, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
			// Ответы личные: в них и своя оценка, и свои отметки. Пусть их
			// не подхватит ни промежуточный кэш, ни соседняя вкладка.
			'Cache-Control': 'private, no-store',
		},
	});
}

const text = (body, status) => new Response(body, {
	status,
	headers: { 'Content-Type': 'text/plain; charset=utf-8' },
});

/** Тело запроса разбором JSON. Кривое тело — это ошибка запроса, а не поломка сайта. */
async function readJson(request) {
	try {
		return await request.json();
	} catch {
		return null;
	}
}

/**
 * Какой раздел открыт по этому адресу и что о нём известно. Ничего не подошло —
 * null, и адрес пойдёт дальше своим чередом, к «страница не найдена».
 *
 * Разделов три вида, и данные им нужны разные:
 *
 *   /topic/anime   — сколько таких паков всего, знает готовый ответ /api/facets:
 *                    он и так лежит у изолята, и второй раз считать то же самое
 *                    было бы платой ни за что;
 *   /subjects/dota — какая группа стоит за куском адреса, знает сведение типов
 *                    (см. src/subject.js): в адресе ключ, а отбор идёт по имени;
 *   /top           — своего числа у топа нет, он и есть свой список.
 */
async function landingFor(db, url) {
	const topic = topicKeyFromPath(url.pathname);

	if (topic) {
		if (!TOPIC_PAGES[topic]) {
			return null;
		}

		const [facets, packs] = await Promise.all([
			getFacets(db),
			landingPacks(db, `topic=${encodeURIComponent(topic)}&unrated=1`, LANDING_SIZE),
		]);

		return topicLanding(topic, facets.topics?.[topic] ?? packs.length, packs);
	}

	const slug = subjectSlugFromPath(url.pathname);

	if (slug) {
		const page = subjectBySlug(await listSubjectGroups(db), slug);

		if (!page) {
			return null;
		}

		// Отбор по названию группы, а не по ключу: сводит написания сама выдача
		const packs = await landingPacks(db,
			`subject=${encodeURIComponent(page.name)}&unrated=1`, LANDING_SIZE);

		return subjectLanding(page, packs, settings.subjectPackShare);
	}

	if (url.pathname === '/top') {
		// Все категории вместе — тем эта заготовка и отличается от того, что
		// нарисует скрипт: он разложит топ по вкладкам, а до скриптов честнее
		// показать общий список, чем одну вкладку из семи.
		const packs = await landingPacks(db, 'sort=popular_quarter&unrated=1', LANDING_SIZE);

		return topLanding(packs);
	}

	return null;
}

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);

		// Общий ответ для невошедших: если такой уже лежит — отдаём его и на этом
		// всё. Читаем из общей полки только те запросы, которые на неё и кладём
		// (см. anonymous): иначе вошедший получил бы ответ, посчитанный без него.
		const shareable = request.method === 'GET' && CACHEABLE.has(url.pathname) && anonymous(request);
		const cache = caches.default;

		if (shareable) {
			const found = await cache.match(request);

			if (found) {
				return found;
			}
		}

		/**
		 * Кладёт готовый общий ответ на полку и отдаёт его же. «Vary: Cookie»
		 * тут не украшение: без него браузер, однажды получив ответ для гостя,
		 * показал бы его и после входа — ключ кэша адреса печенья не включает.
		 */
		const share = response => {
			if (!shareable || response.status !== 200) {
				return response;
			}

			const copy = new Response(response.body, response);
			copy.headers.set('Cache-Control', `public, max-age=${PUBLIC_TTL}`);
			copy.headers.set('Vary', 'Cookie');
			ctx.waitUntil(cache.put(request, copy.clone()));

			return copy;
		};

		try {
			// Кто спрашивает. Без входа это просто null, и сайт работает как раньше:
			// оценки видны, но не ставятся, чёрный список не применяется.
			const user = hasDiscord(env) ? await currentUser(env.DB, request) : null;
			const userId = user?.id ?? null;

			// ————— вход через Discord —————

			if (url.pathname === '/auth/discord') {
				return hasDiscord(env) ? startLogin(env, url) : text('Вход через Discord не настроен', 404);
			}

			if (url.pathname === '/auth/discord/callback') {
				return hasDiscord(env)
					? await finishLogin(env.DB, env, request, url)
					: text('Вход через Discord не настроен', 404);
			}

			if (url.pathname === '/auth/logout' && request.method === 'POST') {
				return await logout(env.DB, request);
			}

			if (url.pathname === '/api/me') {
				return json({ user, hasDiscord: hasDiscord(env) });
			}

			if (url.pathname === '/api/rate' && request.method === 'POST') {
				if (!user) {
					return json({ error: 'Оценивать паки можно, только войдя через Discord' }, 401);
				}

				const body = await readJson(request) ?? {};
				const key = String(body.packKey ?? '');

				// Оценка ставится только тому, во что играли. Иначе она превращается
				// в оценку обложки и описания: пак с красивым названием набирал бы
				// баллы, ни разу не побывав на столе.
				if (!await isPlayedPack(env.DB, userId, key)) {
					return json({ error: 'Оценить пак можно после того, как он отмечен сыгранным' }, 400);
				}

				try {
					return json(await rate(env.DB, key, userId, body.score));
				} catch (error) {
					return json({ error: error.message }, 400);
				}
			}

			if (url.pathname === '/api/blacklist' && request.method === 'POST') {
				// Дома чёрный список можно вести и без входа: там он принадлежит
				// установке, как и отметки «сыграно». Здесь хозяин обязателен —
				// посетителей много, и общий список означал бы, что один спрятал,
				// а пропало у всех.
				if (!user) {
					return json({ error: 'Чёрный список появляется после входа через Discord' }, 401);
				}

				const { kind, value, label, blacklisted } = await readJson(request) ?? {};

				try {
					return json(await setBlacklisted(env.DB, userId, kind, value, label, blacklisted));
				} catch (error) {
					return json({ error: error.message }, 400);
				}
			}

			if (url.pathname === '/api/blacklist') {
				return json({ items: await listBlacklist(env.DB, userId) });
			}

			if (url.pathname === '/api/packages') {
				return share(json(await listPackages(env.DB, url.searchParams, userId, env.ASSETS, url)));
			}

			// Один пак: этим живёт его отдельная страница
			if (url.pathname === '/api/package') {
				const pack = await getPackage(env.DB, parseInt(url.searchParams.get('id') ?? '', 10), userId);

				return pack ? share(json({ package: pack })) : json({ error: 'Такого пака нет' }, 404);
			}

			if (url.pathname === '/api/facets') {
				// Общая часть считается редко и лежит готовой у изолята, а «сколько
				// сыграно» у каждого своё и спрашивается всегда.
				const [facets, played, planned] = await Promise.all([
					getFacets(env.DB),
					playedCount(env.DB, userId),
					plannedCount(env.DB, userId),
				]);

				return share(json({ ...facets, played, planned, hasDiscord: hasDiscord(env), user }));
			}

			// Полный список типов «пак целиком про одно». Отдельным методом
			// от facets: он длинный (сотни строк), а нужен одной странице из шести
			if (url.pathname === '/api/subjects') {
				return share(json(await getSubjects(env.DB)));
			}

			if (url.pathname === '/api/authors') {
				return share(json(await getTopAuthors(env.DB, url.searchParams)));
			}

			if (url.pathname === '/api/profile') {
				return json(await getProfile(env.DB, userId, await listBlacklist(env.DB, userId), url.searchParams));
			}

			if (url.pathname === '/api/played' && request.method === 'POST') {
				// Без входа отметке негде лежать: посетителей много, и общий список
				// значил бы, что один отметил, а загорелось у всех. Но это не «нельзя
				// отмечать вовсе»: до входа отметки живут прямо в браузере, а сюда
				// приезжают все разом в тот миг, когда хозяин появляется
				// (см. web/app.js, перенос местных отметок).
				if (!user) {
					return json({ error: 'Отмечать паки сыгранными можно, только войдя через Discord' }, 401);
				}

				const { id, packKeys, played, markedAt } = await readJson(request) ?? {};

				if (Array.isArray(packKeys)) {
					return json(await setPlayedKeys(env.DB, userId, packKeys, played, markedAt));
				}

				const result = await setPlayed(env.DB, userId, id, played);

				return json(result, result.error ? 404 : 200);
			}

			// Запланированное — отдельным методом, а не признаком у /api/played:
			// это две разные отметки, и снимать одну, ставя другую, сайт не должен
			// (см. таблицу planned в cf/schema.sql).
			if (url.pathname === '/api/planned' && request.method === 'POST') {
				if (!user) {
					return json({ error: 'Планировать паки можно, только войдя через Discord' }, 401);
				}

				const { id, packKeys, planned, markedAt } = await readJson(request) ?? {};

				if (Array.isArray(packKeys)) {
					return json(await setPlannedKeys(env.DB, userId, packKeys, planned, markedAt));
				}

				const result = await setPlanned(env.DB, userId, id, planned);

				return json(result, result.error ? 404 : 200);
			}

			// Список паков файлом. Входа не требует нарочно: здесь ничего не
			// отмечается — только опознаются паки, названные в файле по имени.
			// Отмечает потом /api/played, и до входа отметки, как и всегда,
			// остаются в самом браузере (см. web/card.js).
			if (url.pathname === '/api/list' && request.method === 'POST') {
				const body = await readJson(request) ?? {};

				if (Array.isArray(body.keys)) {
					return json({ packages: await namePacks(env.DB, body.keys) });
				}

				return json(await matchList(env.DB, body));
			}

			// Обновлять тут нечего: индексатора нет, а Gemini и ВК с чужого адреса
			// дёргать не следует. Отвечаем отказом до разбора конкретного метода,
			// чтобы не осталось ни одной работающей лазейки.
			if (url.pathname.startsWith('/api/update/')) {
				return json({ error: 'Обновление базы отключено: сайт работает только на чтение' }, 403);
			}

			if (url.pathname.startsWith('/api/')) {
				return json({ error: 'Неизвестный метод' }, 404);
			}

			// ————— отдельная страница пака —————
			//
			// Открывает её номер, стоящий сразу за /pack/, а название после него —
			// для человека и поисковой выдачи (см. src/slug.js). Вёрстка у всех
			// паков одна и та же и лежит в статике; здесь в неё подставляются
			// заголовок вкладки и описание для поисковика — рисует-то страницу
			// скрипт, а читают их из самого HTML, до всякого JS.
			const packId = packIdFromPath(url.pathname);

			if (packId !== null) {
				const [pack, page] = await Promise.all([
					getPackage(env.DB, packId, userId),
					env.ASSETS.fetch(new URL('/pack.html', url)),
				]);

				const html = await page.text();

				// Пака нет — страница всё равно та же самая: она сама скажет об этом
				// словами и позовёт обратно в библиотеку. Ответ при этом честный,
				// чтобы поисковик не держал у себя ссылку на пропавший пак.
				return new Response(pack ? injectPackMeta(html, pack, url.origin) : html, {
					status: pack ? 200 : 404,
					headers: {
						'Content-Type': 'text/html; charset=utf-8',
						// Личного в этой вёрстке нет ничего: оценки и отметки страница
						// спрашивает сама, уже в браузере
						'Cache-Control': 'public, max-age=300',
					},
				});
			}

			// Подтверждение прав на сайт: тот же файл из статики, но своим
			// адресом и кодом 200, а не отсылкой на адрес без «.html» (см. VERIFY).
			if (VERIFY.has(url.pathname)) {
				const asset = await env.ASSETS.fetch(new URL(url.pathname.replace(/\.html$/, ''), url));

				return new Response(asset.body, {
					status: 200,
					headers: {
						'Content-Type': 'text/html; charset=utf-8',
						'Cache-Control': `public, max-age=${SITEMAP_TTL}`,
					},
				});
			}

			// ————— библиотека: / —————
			//
			// Страница лежит в статике и раздаётся оттуда всем, кроме одного
			// случая: гость, открывший её без отбора. Такому первая страница
			// выдачи и настройки уезжают прямо в вёрстке (см. injectHomeBoot
			// в src/meta.js), и список паков рисуется без единого похода
			// на сервер.
			//
			// Почему только гостю и только без отбора. Заготовка одна на всех
			// и лежит в общем кэше: посчитанная с хозяином, она показала бы его
			// отметки всякому следующему, а посчитанная без отбора — не тот
			// список, о котором просили. Оба условия проверяются до базы:
			// не подошло — Worker не делает ничего, и страницу отдаёт статика,
			// как отдавала раньше.
			//
			// Пять минут кэша, а не час, как разделам: разделы меняются, когда
			// пак начнут играть, а тут сверху лежит самое свежее, и появиться
			// оно должно тогда же, когда появляется в /api/packages.
			const homePage = request.method === 'GET' && url.pathname === '/'
				&& url.search === '' && anonymous(request);

			if (homePage) {
				const cached = await cache.match(request);

				if (cached) {
					return cached;
				}

				const [page, packages, facets] = await Promise.all([
					env.ASSETS.fetch(new URL('/index.html', url)),
					listPackages(env.DB, new URLSearchParams(HOME_QUERY), null, env.ASSETS, url),
					getFacets(env.DB),
				]);

				// Настройки — слово в слово те же, что отдаёт /api/facets гостю:
				// сыграно и запланировано у него ноль, хозяина нет
				const html = injectHomeBoot(await page.text(), {
					packages,
					facets: { ...facets, played: 0, planned: 0, hasDiscord: hasDiscord(env), user: null },
				});

				// «Vary: Cookie» здесь по той же причине, что и у общих ответов
				// API (см. share выше): страница посчитана для гостя и лежит
				// у него в браузере пять минут, а вход её не трогает — ключ
				// кэша адреса печенья не включает. Без этой строки человек,
				// вошедший через Discord, вернулся бы на «свою» библиотеку
				// с чужим уголком входа и неотмеченными паками.
				//
				// Общему кэшу Cloudflare это не мешает: Vary он смотрит только
				// на сжатие, и гости с разными счётчиками попадают в один
				// и тот же ответ.
				const response = new Response(html, {
					headers: {
						'Content-Type': 'text/html; charset=utf-8',
						'Cache-Control': `public, max-age=${PUBLIC_TTL}`,
						'Vary': 'Cookie',
					},
				});

				ctx.waitUntil(cache.put(request, response.clone()));
				return response;
			}

			// ————— страницы разделов: /topic/anime, /subjects/dota, /top —————
			//
			// Ради них всё и затевалось. Раньше раздел жил отбором в адресе
			// библиотеки (/?topic=anime), а canonical у той страницы стоял на «/» —
			// то есть на языке поисковика все отборы были одной и той же главной,
			// и на «паки своя игра аниме» у сайта не было своей страницы вовсе.
			// Теперь есть: свой адрес, свой заголовок, свой текст и свой canonical.
			//
			// Готовая страница ложится в общий кэш Cloudflare на час: собирается
			// она дороже всех прочих, а меняется медленнее всех прочих
			// (см. LANDING_TTL). Личного в ней нет ничего — оценки и отметки
			// страница спрашивает сама, уже в браузере.
			//
			// Похож ли адрес на раздел — решается до всякой базы: иначе кэш,
			// ради которого всё и затевалось, проверялся бы уже после того,
			// как страница собрана.
			const sectionPath = topicKeyFromPath(url.pathname) !== null
				|| subjectSlugFromPath(url.pathname) !== null
				|| url.pathname === '/top';

			if (request.method === 'GET' && sectionPath) {
				const cached = await cache.match(request);

				if (cached) {
					return cached;
				}

				const landing = await landingFor(env.DB, url);

				if (landing) {
					// Топ живёт в своей вёрстке со своими вкладками, у остальных
					// разделов одна на всех: списком паков они отличаются, а не
					// устройством (см. web/landing.html)
					const page = await env.ASSETS.fetch(
						new URL(landing.kind === 'top' ? '/top.html' : '/landing.html', url));

					const html = injectLandingMeta(await page.text(), landing, url.origin);

					const response = new Response(html, {
						headers: {
							'Content-Type': 'text/html; charset=utf-8',
							'Cache-Control': `public, max-age=${LANDING_TTL}`,
						},
					});

					ctx.waitUntil(cache.put(request, response.clone()));
					return response;
				}
			}

			// Карта сайта. Без неё отдельные страницы паков поисковику взять
			// неоткуда: постраничность выдачи сделана кнопками, а не ссылками,
			// и обойти её ползая по ссылкам нельзя.
			if (url.pathname === '/sitemap.xml') {
				const found = await cache.match(request);

				if (found) {
					return found;
				}

				// Разделы едут в карту вместе с паками: сами по себе они
				// поисковику неоткуда взяться — ссылки на них стоят на страницах
				// таких же разделов, а первую из них найти неоткуда
				const [rows, groups] = await Promise.all([listSitemap(env.DB), listSubjectGroups(env.DB)]);
				const facets = await getFacets(env.DB);

				const body = buildSitemap(rows, url.origin, {
					topics: TOPIC_PAGE_KEYS.filter(key => (facets.topics?.[key] ?? 0) > 0),
					subjects: subjectPages(groups),
				});

				const response = new Response(body, {
					headers: {
						'Content-Type': 'application/xml; charset=utf-8',
						'Cache-Control': `public, max-age=${SITEMAP_TTL}`,
					},
				});

				ctx.waitUntil(cache.put(request, response.clone()));
				return response;
			}

			if (url.pathname === '/robots.txt') {
				return new Response(buildRobots(url.origin), {
					headers: {
						'Content-Type': 'text/plain; charset=utf-8',
						'Cache-Control': `public, max-age=${SITEMAP_TTL}`,
					},
				});
			}

			// Сюда доходит только то, чего в статике не нашлось. Обычно это ошибка
			// в адресе, и пусть на неё отвечает та же страница «не найдено»,
			// что и на всё остальное.
			return await env.ASSETS.fetch(request);
		} catch (error) {
			console.error(error);
			return json({ error: error.message }, 500);
		}
	},
};
