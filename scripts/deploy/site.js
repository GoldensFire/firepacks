// По какому адресу открывается сайт наверху.
//
// Вопрос этот задают двое и по разным поводам: пинг поисковикам складывает
// из адреса все ссылки карты сайта, а плашка технических работ стучится по нему
// же, чтобы проверить, отвечает ли выложенный Worker. Жил ответ у первого
// из них, и второму пришлось бы либо тянуть из чужого файла, либо завести
// второе такое же чтение wrangler.jsonc — то есть два места, которые однажды
// разойдутся.
//
// Отсюда третий файл: он не знает ни про пинг, ни про работы, а знает только
// адрес.

import fs from 'node:fs';
import path from 'node:path';

import { root } from './options.js';
import { CLOUDFLARE_ENV } from './wrangler.js';
import { CLOUDFLARE_API, accountId } from './d1.js';

/** Спрошенный однажды адрес. Меняться ему в пределах запуска не с чего. */
let knownOrigin = null;

/**
 * Адрес сайта наверху. Своё имя старше запасного: есть в wrangler.jsonc
 * "custom_domain" — берём его, и поисковику уезжают адреса на firepacks.net,
 * те же самые, что стоят в карте сайта и в canonical у страниц (их сайт
 * считает от адреса запроса). Пропинговать старое имя на workers.dev значило бы
 * звать поисковик на страницы, которые сами про себя говорят, что настоящие
 * они по другому адресу, — и такой пинг пропал бы впустую.
 *
 * Имён может быть несколько (firepacks.net и www.firepacks.net); берём первое —
 * оно и есть главное, без «www».
 *
 * Своего имени нет — считаем запасной адрес из имени Worker и поддомена
 * учётной записи, того самого, что стоит в firepacks.<поддомен>.workers.dev.
 *
 * @returns {Promise<string>} «https://…» или пустая строка, если не спросилось
 */
export async function siteOrigin() {
	if (knownOrigin !== null) {
		return knownOrigin;
	}

	const config = fs.readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8');
	const custom = /"pattern"\s*:\s*"([^"]+)"\s*,\s*"custom_domain"\s*:\s*true/.exec(config)?.[1];

	if (custom) {
		knownOrigin = `https://${custom}`;
		return knownOrigin;
	}

	// Без постоянного ключа запасной адрес не спросить: у Cloudflare о нём
	// спрашивают по REST, а тот пропуском из браузера не пользуется. Пустая
	// строка здесь честнее, чем поход в accountId, который в этом случае
	// уронил бы весь запуск.
	if (!CLOUDFLARE_ENV.CLOUDFLARE_API_TOKEN) {
		knownOrigin = '';
		return knownOrigin;
	}

	const name = /"name"\s*:\s*"([^"]+)"/.exec(config)?.[1] ?? '';
	const account = await accountId();

	const response = await fetch(`${CLOUDFLARE_API}/accounts/${account}/workers/subdomain`, {
		headers: { Authorization: `Bearer ${CLOUDFLARE_ENV.CLOUDFLARE_API_TOKEN}` },
	});

	const body = await response.json().catch(() => null);
	const subdomain = body?.result?.subdomain ?? '';

	knownOrigin = name && subdomain ? `https://${name}.${subdomain}.workers.dev` : '';
	return knownOrigin;
}
