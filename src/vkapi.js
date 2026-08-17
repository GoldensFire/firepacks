// Чтение обсуждений через VK API. Работает, когда есть ключ; иначе остаётся разбор HTML.

import { config } from './config.js';
import { normalizeTopicUrl } from './vk.js';

const PAGE_SIZE = 100;

/** Есть ли ключ VK API. */
export function hasVkApi() {
	return Boolean(config.vkToken);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Сколько раз повторять запрос, споткнувшийся о сеть или о «слишком часто». */
const CALL_ATTEMPTS = 5;

/**
 * Сколько раз перечитывать окно, которое пришло пустым посреди темы. Ошибки
 * в таком ответе нет, повторять его на уровне вызова не за что — а вот на уровне
 * обхода стоит: заминка проходит за секунду-другую (см. readTopic).
 */
const WINDOW_ATTEMPTS = 3;

/**
 * Вызов метода API. Ошибка 6 — «слишком часто», её повторяем;
 * остальные означают, что дальше идти бессмысленно.
 *
 * Оборванная сеть повторяется наравне с ней. Раньше её не повторял никто, и стоило
 * это дорого: одна оборванная страница означала брошенную тему целиком и тысячи
 * ненайденных паков (см. readTopic).
 */
export async function callVk(method, params, attempt = 1, attempts = CALL_ATTEMPTS) {
	const query = new URLSearchParams({
		...params,
		access_token: config.vkToken,
		v: config.vkApiVersion,
	});

	let response;

	try {
		response = await fetch(`https://api.vk.com/method/${method}`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				'User-Agent': config.userAgent,
			},
			body: query.toString(),
		});
	} catch (error) {
		if (attempt < attempts) {
			await sleep(config.vkDelayMs * attempt * 2);
			return callVk(method, params, attempt + 1, attempts);
		}

		throw new Error(`не дозвонились до VK API: ${error.message}`);
	}

	// 5xx у ВК — обычное дело под нагрузкой, и это не отказ, а «зайдите попозже»
	if (response.status >= 500 && attempt < attempts) {
		await sleep(config.vkDelayMs * attempt * 2);
		return callVk(method, params, attempt + 1, attempts);
	}

	let data;

	try {
		data = await response.json();
	} catch (error) {
		if (attempt < attempts) {
			await sleep(config.vkDelayMs * attempt * 2);
			return callVk(method, params, attempt + 1, attempts);
		}

		throw new Error(`VK API ответил не по-человечески (HTTP ${response.status}): ${error.message}`);
	}

	if (data.error) {
		const code = data.error.error_code;

		if ((code === 6 || code === 9 || code === 10 || code === 1) && attempt < attempts) {
			await sleep(config.vkDelayMs * attempt * 2);
			return callVk(method, params, attempt + 1, attempts);
		}

		const hints = {
			5: 'ключ не подошёл: он истёк или скопирован с ошибкой',
			15: 'нет доступа: сервисного ключа мало, нужен пользовательский токен',
			29: 'исчерпан суточный лимит метода',
		};

		throw new Error(`VK API ${code}: ${data.error.error_msg}${hints[code] ? ` (${hints[code]})` : ''}`);
	}

	return data.response;
}

/** Достаёт из ссылки на обсуждение номер сообщества и номер темы. */
export function parseTopicUrl(url) {
	const match = /topic(-?\d+)_(\d+)/.exec(url);

	if (!match) {
		throw new Error(`не похоже на ссылку на обсуждение: ${url}`);
	}

	return { groupId: Math.abs(parseInt(match[1], 10)), topicId: parseInt(match[2], 10) };
}

function formatDate(unixSeconds) {
	return new Date(unixSeconds * 1000).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

function buildAuthor(fromId, profiles, groups) {
	if (fromId > 0) {
		const profile = profiles.get(fromId);

		return profile
			? { name: `${profile.first_name} ${profile.last_name}`.trim(), url: `https://vk.com/id${fromId}` }
			: { name: '', url: '' };
	}

	const group = groups.get(Math.abs(fromId));

	return group
		? { name: group.name, url: `https://vk.com/club${Math.abs(fromId)}` }
		: { name: '', url: '' };
}

/**
 * Ошибка, которая привязана не к нам, а к тому, что мы просим: ВК не может
 * собрать ответ по этому куску темы и говорит «внутренняя ошибка, зайдите позже».
 * Позже не помогает — см. readWindow.
 */
function isBrokenWindow(error) {
	return /VK API (10|100)\b/.test(error.message);
}

/**
 * Читает кусок обсуждения: сообщения с offset по offset+count.
 *
 * Почему это не просто вызов метода. В большой теме попадаются сообщения, на
 * которых ВК спотыкается сам: любой запрос, куда такое сообщение попадает,
 * возвращает «Internal server error: Unknown error, try later». «Позже» не
 * наступает никогда — проверено, отказ повторяется и через час, и на другом
 * размере окна. Зато соседние куски читаются прекрасно: сотня сообщений
 * с того же места падает, а десяток — приходит.
 *
 * Отсюда и способ: не смогли прочитать окно — делим пополам и читаем половины
 * порознь, пока не останется одно сообщение. Одно нечитаемое сообщение
 * пропускается, и обход идёт дальше. Раньше оно останавливало тему целиком:
 * именно из-за такого сообщения на четырёх тысячах в базу не попали семь тысяч
 * паков, лежавших дальше по теме.
 *
 * Возвращается не только то, что прочитано, но и сколько мест в теме этот кусок
 * занял: пропущенное сообщение места своего не теряет, и без этого счёта обход
 * топтался бы на нём вечно.
 *
 * @returns {Promise<{items: Array, total: number|null, consumed: number, skipped: number}>}
 */
async function readWindow(groupId, topicId, offset, count, onSkip, sort = 'asc') {
	try {
		// Попыток немного нарочно: если это та самая неисправимая ошибка, ждать
		// её бесполезно, а делить окно — полезно, и чем скорее, тем лучше
		const response = await callVk('board.getComments', {
			group_id: groupId,
			topic_id: topicId,
			offset,
			count,
			sort,
			extended: 1,
		}, 1, 3);

		const items = response.items ?? [];

		return {
			items,
			total: Number.isFinite(response.count) ? response.count : null,
			profiles: response.profiles ?? [],
			groups: response.groups ?? [],
			consumed: items.length,
			skipped: 0,
		};
	} catch (error) {
		if (!isBrokenWindow(error)) {
			throw error;
		}

		if (count <= 1) {
			onSkip?.(offset, error);
			return { items: [], total: null, profiles: [], groups: [], consumed: 1, skipped: 1 };
		}

		// Половины читаются по очереди, а не разом: вторая начинается там, где
		// кончилась первая, а кончиться первая может и раньше, чем обещала, —
		// в конце темы просто нет столько сообщений, сколько попросили
		const half = Math.ceil(count / 2);
		const left = await readWindow(groupId, topicId, offset, half, onSkip, sort);
		const right = left.consumed < half
			? { items: [], total: null, profiles: [], groups: [], consumed: 0, skipped: 0 }
			: await readWindow(groupId, topicId, offset + left.consumed, count - left.consumed, onSkip, sort);

		return {
			items: [...left.items, ...right.items],
			total: left.total ?? right.total,
			profiles: [...left.profiles, ...right.profiles],
			groups: [...left.groups, ...right.groups],
			consumed: left.consumed + right.consumed,
			skipped: left.skipped + right.skipped,
		};
	}
}

/**
 * Сообщения окна — в тот вид, в каком их ждёт индексатор. Отдаются только те,
 * где есть прикреплённые файлы: остальные для базы паков пусты.
 *
 * Вынесено отдельно, потому что окна читают двое: обход темы целиком (readTopic)
 * и обход её хвоста (readTopicSince). Разбирать ответ ВК они обязаны совершенно
 * одинаково — разница между ними только в том, откуда и докуда идти.
 */
function buildComments(response, normalized) {
	const profiles = new Map(response.profiles.map(profile => [profile.id, profile]));
	const groups = new Map(response.groups.map(group => [group.id, group]));
	const comments = [];

	for (const item of response.items) {
		const documents = [];

		for (const attachment of item.attachments ?? []) {
			if (attachment.type !== 'doc') {
				continue;
			}

			const doc = attachment.doc;

			documents.push({
				key: `doc${doc.owner_id}_${doc.id}`,
				url: doc.url,
				// title приходит без расширения не всегда — приводим к виду «имя.siq»
				fileName: /\.\w+$/.test(doc.title) ? doc.title : `${doc.title}.${doc.ext}`,
				size: doc.size,
			});
		}

		if (documents.length === 0) {
			continue;
		}

		const author = buildAuthor(item.from_id, profiles, groups);

		comments.push({
			id: item.id,
			topicUrl: normalized,
			author: author.name,
			authorUrl: author.url,
			date: formatDate(item.date),
			// Точное время сообщения: разбирать строку, как на странице, не нужно
			ts: item.date * 1000,
			text: (item.text ?? '').trim(),
			documents,
		});
	}

	return comments;
}

/**
 * Перебирает комментарии обсуждения через API и отдаёт те, где есть файлы.
 * Форма результата совпадает с разбором HTML, чтобы индексатору было всё равно, откуда данные.
 *
 * Где кончается тема. Раньше признаком конца считалась короткая страница: пришло
 * меньше сотни — значит всё. Признак этот неверен дважды. Во-первых, ВК отдаёт
 * неполную страницу и в середине темы — удалённые сообщения из выдачи выпадают,
 * а место в отсчёте занимают; во-вторых, любая оборванная страница выглядела
 * точно так же. В теме на двадцать шесть тысяч сообщений это стоило семи тысяч
 * ненайденных паков: обход останавливался на середине и объявлял, что дошёл
 * до конца. Теперь конец — это то, что сказал сам ВК: `count` в ответе, число
 * сообщений в теме. Смещение при этом двигается на столько, сколько пришло,
 * а не на сотню, — короткая страница в середине больше ничего не пропускает.
 *
 * Пустое окно посреди темы. Ответ без единого сообщения раньше значил «тема
 * кончилась» — и этого хватило, чтобы ночь с 14 на 15 августа прочитала 10400
 * сообщений из 26289 и объявила обход неполным. Ответ был удачным, ошибки в нём
 * не было, просто список пришёл пустой; повторный запрос того же куска через
 * минуту отдал все сто сообщений. Теперь пустому окну верят только в конце темы:
 * пока ВК обещает больше сообщений, чем прочитано, окно перечитывается, а если
 * оно так и не даётся — обход перешагивает его и идёт дальше, сказав об этом
 * вслух (onGap). Пропущенное окно — не конец темы, и молчать о нём нельзя:
 * в нём могло лежать до сотни сообщений с паками.
 *
 * @param {string} topicUrl ссылка на тему
 * @param {object} options maxPages — сколько страниц пройти, onPage — колбэк прогресса,
 *   onSkip — нечитаемое сообщение, onGap — перешагнутое окно
 */
export async function* readTopic(topicUrl, options = {}) {
	const maxPages = options.maxPages ?? Infinity;
	const { groupId, topicId } = parseTopicUrl(topicUrl);
	const normalized = normalizeTopicUrl(topicUrl);

	let offset = 0;
	let page = 0;
	let total = null;
	let lastSeenId = null;
	let skipped = 0;
	let retries = 0;

	while (page < maxPages) {
		const response = await readWindow(groupId, topicId, offset, PAGE_SIZE, (at, error) => {
			skipped++;
			options.onSkip?.(at, error);
		});

		const items = response.items;

		if (response.total !== null) {
			total = response.total;
		}

		// Обещал ли ВК больше, чем мы уже прочитали. Пока обещает — ни пустое
		// окно, ни повторившееся не означают конца темы
		const promisedMore = total !== null && offset < total;

		// Окно пустое, либо в нём ровно то же, что в прошлом: продвинуться по нему
		// нельзя, а цикл с бесконечным maxPages без этой проверки крутился бы вечно
		const stuck = (items.length === 0 && response.consumed === 0)
			|| (items.length > 0 && items.at(-1).id === lastSeenId);

		if (stuck) {
			if (!promisedMore) {
				return;
			}

			// Сначала — просто перечитать: пустое окно посреди темы почти всегда
			// оказывается заминкой на стороне ВК и проходит само
			if (retries < WINDOW_ATTEMPTS) {
				retries++;
				await sleep(config.vkDelayMs * retries * 2);
				continue;
			}

			// Не далось и с третьего раза — перешагиваем окно целиком. Место
			// в теме оно занимает, поэтому смещение двигается на полную страницу
			retries = 0;
			options.onGap?.(offset, PAGE_SIZE);
			offset += PAGE_SIZE;

			// Перешагнутое окно — тоже пройденные места в теме, и счётчик
			// прочитанного должен их учесть: иначе обход, шагнувший через конец
			// темы, сам себя объявит недочитанным (см. scanVk)
			options.onPage?.({ page, offset, found: 0, read: offset, total, skipped });

			if (offset >= total) {
				return;
			}

			await sleep(config.vkDelayMs);
			continue;
		}

		retries = 0;

		if (items.length > 0) {
			lastSeenId = items.at(-1).id;
		}

		const comments = buildComments(response, normalized);

		page++;

		if (options.onPage) {
			options.onPage({ page, offset, found: comments.length, read: offset + response.consumed, total, skipped });
		}

		for (const comment of comments) {
			yield comment;
		}

		// Смещение считается по тому, сколько мест в теме занял прочитанный кусок:
		// сотня в запросе — это просьба, а не обещание, а пропущенное нечитаемое
		// сообщение своё место в отсчёте всё равно занимает
		offset += response.consumed;

		if (total !== null && offset >= total) {
			return;
		}

		// Сколько всего сообщений в теме, ВК не сказал — остаётся прежний признак
		if (total === null && response.consumed < PAGE_SIZE) {
			return;
		}

		await sleep(config.vkDelayMs);
	}
}

/**
 * Сколько окон читать после того, как отсечка пройдена.
 *
 * Сообщения в обсуждении идут строго по времени, и первое же сообщение старше
 * отсечки означает, что дальше вниз всё только старше. Но обход, у которого
 * запас ровно нулевой, ошибается на любой мелочи: сообщение, отредактированное
 * вчера, соседство удалённых, отсечка, посчитанная от даты пака, а не от даты
 * сообщения. Одно лишнее окно — это один лишний запрос к ВК, то есть секунда;
 * пропущенный пак — это сутки ожидания.
 */
const OVERLAP_WINDOWS = 1;

/**
 * Читает ХВОСТ обсуждения: сообщения не старше указанного мига.
 *
 * Зачем это отдельно от readTopic. Тот идёт от начала темы и читает её целиком —
 * иначе нельзя, ведь его дело в том числе заметить, что в старом сообщении
 * подменили или убрали файл. В теме на двадцать шесть тысяч сообщений это
 * двести шестьдесят с лишним запросов к ВК с паузой между ними, то есть минут
 * десять, и ежечасный обход тратил их целиком — ради того, чтобы в самом конце
 * найти ноль или один новый пак.
 *
 * Здесь же вопрос стоит иначе: не «что в теме есть», а «что в ней появилось
 * с такого-то дня». Ответ на него лежит в самом хвосте, и ВК умеет отдать тему
 * с конца (sort=desc). Обход читает окно за окном от свежего к старому и уходит,
 * как только доходит до сообщений старше отсечки, — обычно это первое же окно.
 * Десять минут превращаются в секунды, и от числа сообщений в теме время больше
 * не зависит вовсе.
 *
 * Чего этот обход НЕ делает — и потому зовущий обязан считать его неполным:
 * он не видит старой части темы, а значит, не может судить о пропавших
 * и подменённых файлах (см. applyPending в indexer.js). Его дело — только новое.
 *
 * @param {string} topicUrl ссылка на тему
 * @param {number} since миг (мс), раньше которого сообщения не нужны
 * @param {object} options maxPages, onPage, onSkip — как у readTopic
 */
export async function* readTopicSince(topicUrl, since, options = {}) {
	const maxPages = options.maxPages ?? Infinity;
	const { groupId, topicId } = parseTopicUrl(topicUrl);
	const normalized = normalizeTopicUrl(topicUrl);

	let offset = 0;
	let page = 0;
	let total = null;
	let skipped = 0;
	let past = 0;

	while (page < maxPages) {
		const response = await readWindow(groupId, topicId, offset, PAGE_SIZE, (at, error) => {
			skipped++;
			options.onSkip?.(at, error);
		}, 'desc');

		if (response.total !== null) {
			total = response.total;
		}

		// Окно не отдалось вовсе. Для обхода хвоста это не повод перечитывать
		// и перешагивать, как в readTopic: там впереди была вся тема, а здесь
		// впереди только то, что старше, — и его всё равно принесёт ночь
		if (response.consumed === 0) {
			return;
		}

		// Дошли ли до старого. Сообщения идут от свежего к старому, поэтому
		// довольно посмотреть на последнее в окне: оно самое старое из прочитанных
		const oldest = response.items.at(-1);
		const reached = oldest !== undefined && oldest.date * 1000 < since;

		const comments = buildComments(response, normalized);
		page++;

		options.onPage?.({ page, offset, found: comments.length, read: offset + response.consumed, total, skipped });

		for (const comment of comments) {
			yield comment;
		}

		offset += response.consumed;

		if (total !== null && offset >= total) {
			return;
		}

		if (reached && past++ >= OVERLAP_WINDOWS) {
			return;
		}

		await sleep(config.vkDelayMs);
	}
}

/**
 * Свежая ссылка на документ. Ссылки из API подписаны и со временем перестают работать,
 * поэтому постоянным считается только ключ вида doc123_456.
 */
export async function refreshDocumentUrl(sourceKey) {
	const match = /^doc(-?\d+)_(\d+)$/.exec(sourceKey);

	if (!match) {
		return null;
	}

	const docs = await callVk('docs.getById', { docs: `${match[1]}_${match[2]}` });
	return docs?.[0]?.url ?? null;
}
