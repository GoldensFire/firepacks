// Чтение обсуждений ВК без авторизации. Страница отдаётся в windows-1251.

import { config } from './config.js';

const decoder = new TextDecoder('windows-1251');
const PAGE_SIZE = 20;

function decodeEntities(value) {
	return value
		.replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
		.replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(parseInt(code, 10)))
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&nbsp;/g, ' ');
}

function stripTags(html) {
	return decodeEntities(html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '')).trim();
}

/** Приводит ссылку на тему к виду, который отдаёт полноценный HTML. */
export function normalizeTopicUrl(url) {
	return url.replace('vk.com', 'vk.ru').split('?')[0];
}

async function loadPage(topicUrl, offset) {
	const url = `${normalizeTopicUrl(topicUrl)}?offset=${offset}`;

	const response = await fetch(url, {
		headers: {
			'User-Agent': config.userAgent,
			'Accept-Language': 'ru-RU,ru;q=0.9',
		},
	});

	if (!response.ok) {
		throw new Error(`ВК ответил HTTP ${response.status}`);
	}

	return decoder.decode(new Uint8Array(await response.arrayBuffer()));
}

function parseComments(html, topicUrl) {
	const blocks = html.split('<div class="bp_post');
	const comments = [];

	for (let i = 1; i < blocks.length; i++) {
		const block = blocks[i];
		const idMatch = /id="post-(-?\d+)_(\d+)"/.exec(block);

		if (!idMatch) {
			continue;
		}

		const authorMatch = /<a class="bp_author"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
		const dateMatch = /<a class="bp_date"[^>]*>([\s\S]*?)<\/a>/.exec(block);
		const textMatch = /<div class="bp_text"[^>]*>([\s\S]*?)<\/div>/.exec(block);

		const documents = [];
		const seen = new Set();
		const docPattern = /<a class="page_doc_title"[^>]*href="\/(doc-?\d+_\d+\?hash=[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
		let docMatch;

		while ((docMatch = docPattern.exec(block)) !== null) {
			const href = decodeEntities(docMatch[1]);
			const key = href.split('?')[0];

			if (seen.has(key)) {
				continue;
			}

			seen.add(key);

			documents.push({
				key,
				url: `https://vk.com/${href}`,
				fileName: stripTags(docMatch[2]),
			});
		}

		if (documents.length === 0) {
			continue;
		}

		comments.push({
			id: parseInt(idMatch[2], 10),
			topicUrl: normalizeTopicUrl(topicUrl),
			author: authorMatch ? stripTags(authorMatch[2]) : '',
			authorUrl: authorMatch ? `https://vk.com${decodeEntities(authorMatch[1])}` : '',
			date: dateMatch ? stripTags(dateMatch[1]) : '',
			text: textMatch ? stripTags(textMatch[1]) : '',
			documents,
		});
	}

	return comments;
}

/**
 * Перебирает страницы обсуждения с начала темы и отдаёт комментарии с файлами.
 * Новые сообщения ВК добавляет в конец, поэтому полный проход всегда захватывает свежие.
 * @param {string} topicUrl ссылка на тему
 * @param {object} options maxPages — сколько страниц пройти, onPage — колбэк прогресса
 */
export async function* readTopic(topicUrl, options = {}) {
	const maxPages = options.maxPages ?? Infinity;
	let offset = 0;
	let page = 0;

	while (page < maxPages) {
		const html = await loadPage(topicUrl, offset);
		const hasPosts = html.includes('<div class="bp_post');

		if (!hasPosts) {
			return;
		}

		const comments = parseComments(html, topicUrl);
		page++;

		// Сколько всего сообщений в теме, со страницы не видно: total остаётся пустым,
		// и полоска выполнения у этого способа обхода просто считает прочитанное
		if (options.onPage) {
			options.onPage({ page, offset, found: comments.length, read: offset + PAGE_SIZE, total: null });
		}

		for (const comment of comments) {
			yield comment;
		}

		offset += PAGE_SIZE;
		await new Promise(resolve => setTimeout(resolve, config.vkDelayMs));
	}
}
