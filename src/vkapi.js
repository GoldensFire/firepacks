// Чтение обсуждений через VK API. Работает, когда есть ключ; иначе остаётся разбор HTML.

import { config } from './config.js';
import { normalizeTopicUrl } from './vk.js';

const PAGE_SIZE = 100;

/** Есть ли ключ VK API. */
export function hasVkApi() {
	return Boolean(config.vkToken);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Вызов метода API. Ошибка 6 — «слишком часто», её повторяем;
 * остальные означают, что дальше идти бессмысленно.
 */
export async function callVk(method, params, attempt = 1) {
	const query = new URLSearchParams({
		...params,
		access_token: config.vkToken,
		v: config.vkApiVersion,
	});

	const response = await fetch(`https://api.vk.com/method/${method}`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			'User-Agent': config.userAgent,
		},
		body: query.toString(),
	});

	const data = await response.json();

	if (data.error) {
		const code = data.error.error_code;

		if ((code === 6 || code === 9) && attempt < 4) {
			await sleep(config.vkDelayMs * attempt * 2);
			return callVk(method, params, attempt + 1);
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
 * Перебирает комментарии обсуждения через API и отдаёт те, где есть файлы.
 * Форма результата совпадает с разбором HTML, чтобы индексатору было всё равно, откуда данные.
 * @param {string} topicUrl ссылка на тему
 * @param {object} options maxPages — сколько страниц пройти, onPage — колбэк прогресса
 */
export async function* readTopic(topicUrl, options = {}) {
	const maxPages = options.maxPages ?? Infinity;
	const { groupId, topicId } = parseTopicUrl(topicUrl);
	const normalized = normalizeTopicUrl(topicUrl);

	let offset = 0;
	let page = 0;

	while (page < maxPages) {
		const response = await callVk('board.getComments', {
			group_id: groupId,
			topic_id: topicId,
			offset,
			count: PAGE_SIZE,
			sort: 'asc',
			extended: 1,
		});

		const items = response.items ?? [];

		if (items.length === 0) {
			return;
		}

		const profiles = new Map((response.profiles ?? []).map(p => [p.id, p]));
		const groups = new Map((response.groups ?? []).map(g => [g.id, g]));

		const comments = [];

		for (const item of items) {
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

		page++;

		if (options.onPage) {
			options.onPage(page, offset, comments.length);
		}

		for (const comment of comments) {
			yield comment;
		}

		if (items.length < PAGE_SIZE) {
			return;
		}

		offset += PAGE_SIZE;
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
