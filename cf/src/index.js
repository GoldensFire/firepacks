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
	matchList, namePacks,
} from './library.js';

import { packIdFromPath } from '../../src/slug.js';
import { injectPackMeta, buildSitemap, buildRobots } from '../../src/meta.js';

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
				return share(json(await listPackages(env.DB, url.searchParams, userId)));
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

			// Карта сайта. Без неё отдельные страницы паков поисковику взять
			// неоткуда: постраничность выдачи сделана кнопками, а не ссылками,
			// и обойти её ползая по ссылкам нельзя.
			if (url.pathname === '/sitemap.xml') {
				const found = await cache.match(request);

				if (found) {
					return found;
				}

				const body = buildSitemap(await listSitemap(env.DB), url.origin);

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
