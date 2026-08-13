// Индексатор: собирает паки из обсуждений ВК, разбирает их и подтягивает статистику.
//
//   node src/indexer.js                 полный проход
//   node src/indexer.js --vk-only       только обойти обсуждения: новое и правки
//   node src/indexer.js --parse-only    только разобрать нерасобранные паки
//   node src/indexer.js --stats-only    только обновить статистику
//   node src/indexer.js --topics-only   только определить тематики через Gemini
//   node src/indexer.js --summary-only  только составить краткие описания паков
//   node src/indexer.js --logos         только докачать логотипы
//   node src/indexer.js --specials      досчитать спецвопросы у старых паков
//   node src/indexer.js --reparse       разобрать заново уже разобранные паки
//   node src/indexer.js --retopics      переспросить Gemini даже про уже размеченные паки
//   node src/indexer.js --resummary     переписать уже готовые описания
//   node src/indexer.js --recalc        пересчитать уровни и ярлыки по сохранённым данным, без сети
//   node src/indexer.js --steps=a,b     явный список шагов: vk, parse, stats, topics, summary, logos, specials, recalc
//   node src/indexer.js --gemini-models показать доступные модели Gemini
//   node src/indexer.js --pages=5       ограничить число страниц обсуждения
//   node src/indexer.js --limit=20      ограничить число обрабатываемых паков
//   node src/indexer.js --retry         попробовать заново паки с ошибками
//
// Шаги можно сочетать: --stats-only --topics-only сделает и то, и другое.
// Тем же пользуется страница обновления базы — см. web/update.html.

import fs from 'node:fs';
import path from 'node:path';
import { config, TOPICS_VERSION, PROGRESS_PREFIX } from './config.js';
import { db, buildMatchKey, buildTagsKey, saveAuthors, parseVkDate, normalizeRounds, jsonOrDefault } from './db.js';
import { readTopic as readTopicHtml } from './vk.js';
import { readTopic as readTopicApi, hasVkApi, refreshDocumentUrl } from './vkapi.js';
import { openRemoteZip, DeadLinkError } from './zip.js';
import { parseContentXml } from './siq.js';
import { fetchPackageStats, summarize, toLevel } from './stats.js';
import { hasGemini, classifyThemes, describePack, listModels } from './gemini.js';
import { listThemes, computeShares, toPrimary, computeFranchises } from './topics.js';

const args = process.argv.slice(2);
const has = flag => args.includes(flag);
const text = name => args.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? '';
const value = (name, fallback) => {
	const found = text(name);
	return found ? Number(found) : fallback;
};

const reparse = has('--reparse');
const retopics = has('--retopics');
const resummary = has('--resummary');
const retryFailed = has('--retry');
const maxPages = value('pages', Infinity);
const limit = value('limit', Infinity);

/**
 * Отчёт о ходе работы для страницы обновления базы: сколько сделано из скольких.
 * В обычном запуске из консоли эти строки только мешали бы, поэтому печатаются,
 * лишь когда индексатор запущен сайтом (см. server.js).
 */
const guiMode = process.env.FIREPACKS_GUI === '1';

function report(event) {
	if (guiMode) {
		process.stdout.write(PROGRESS_PREFIX + JSON.stringify(event) + '\n');
	}
}

/** Короткая запись: «шаг такой-то, сделано столько из стольких». */
const progress = (step, done, total) => report({ step, done, total });

const insertPackage = db.prepare(`
	INSERT OR IGNORE INTO packages
		(source_key, url, file_name, vk_topic, vk_comment, vk_author, vk_author_url, vk_date, vk_ts, comment_text, status)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')
`);

const refreshLink = db.prepare('UPDATE packages SET url = ?, file_name = ? WHERE source_key = ?');

// ————— сверка с обсуждением: что в сообщении поменялось с прошлого раза —————

/** Всё, что мы уже знаем про это сообщение обсуждения. */
const knownInComment = db.prepare(`
	SELECT id, source_key, name, file_name, comment_text, status
	FROM packages WHERE vk_topic = ? AND vk_comment = ?
`);

/**
 * Сообщение переписали: у пака меняется описание, но не он сам. Заодно
 * обновляются имя и время автора — сообщение могли перенести или подписать иначе.
 */
const refreshComment = db.prepare(`
	UPDATE packages SET comment_text = ?, vk_author = ?, vk_author_url = ?, vk_date = ?, vk_ts = ?
	WHERE id = ?
`);

/**
 * Файл в сообщении подменили: тот же пак выложен заново, обычно с исправлениями.
 * Ссылка и ключ переезжают на новый документ, а сам пак помечается к пересборке.
 *
 * Разметка сбрасывается нарочно: тематики и краткое описание считались по прежнему
 * содержимому, и оставлять их — значит подписать новый пак старыми словами. Сами
 * значения при этом остаются на месте, а не обнуляются: пока не приехали новые,
 * пусть на карточке будет прошлогоднее описание, а не пустота.
 *
 * Строка остаётся «ok», если была ею: пак не должен пропадать с сайта на сутки
 * из-за того, что автор перезалил файл. Мёртвой ссылке, наоборот, дают новый шанс.
 */
const rebindDocument = db.prepare(`
	UPDATE packages SET
		source_key = ?, url = ?, file_name = ?,
		recheck = 1, error = NULL, topics_at = NULL, summary_at = NULL,
		status = CASE WHEN status = 'ok' THEN 'ok' ELSE 'new' END
	WHERE id = ?
`);

/** Файл из сообщения убрали. Не удаляем: вернут — оживёт, а оценки к нему привязаны. */
const markGone = db.prepare(`UPDATE packages SET status = 'gone', error = ? WHERE id = ?`);

/** Файл вернули на место. */
const markBack = db.prepare(`UPDATE packages SET status = 'new', error = NULL WHERE id = ?`);

const updateParsed = db.prepare(`
	UPDATE packages SET
		name = ?, authors = ?, authors_key = ?, match_key = ?, tags = ?, tags_key = ?, author_difficulty = ?,
		language = ?, pack_date = ?, pack_id = ?, size = ?, question_count = ?, round_count = ?,
		theme_count = ?, special_count = ?, special_stat = ?, content_stat = ?, rounds = ?,
		logo_file = ?, logo_state = ?,
		status = 'ok', error = NULL, recheck = 0, indexed_at = ?
	WHERE id = ?
`);

const updateFailed = db.prepare(`UPDATE packages SET status = ?, error = ?, recheck = 0, indexed_at = ? WHERE id = ?`);

/**
 * Пометку «разобрать заново» снимает любой исход разбора, в том числе неудачный.
 * Иначе пак, который перезалили сломанным, просился бы в очередь каждую ночь
 * и никогда бы из неё не выходил.
 */
const clearRecheck = db.prepare('UPDATE packages SET recheck = 0 WHERE id = ?');
const updateUrl = db.prepare('UPDATE packages SET url = ? WHERE id = ?');
const updateLogo = db.prepare('UPDATE packages SET logo_file = ?, logo_state = ? WHERE id = ?');
const updateTopics = db.prepare(`
	UPDATE packages SET topic_shares = ?, primary_topic = ?, primary_share = ?,
		franchises = ?, franchise_top = ?, franchise_top_share = ?,
		topics_at = ?, topics_version = ${TOPICS_VERSION} WHERE id = ?
`);

const updateSummary = db.prepare('UPDATE packages SET summary = ?, summary_at = ? WHERE id = ?');
const updateSpecials = db.prepare('UPDATE packages SET special_count = ?, special_stat = ? WHERE id = ?');

const upsertStats = db.prepare(`
	INSERT INTO stats (package_id, started_games, completed_games, shown, answered, correct, wrong,
		right_percent, take_percent, level, found, updated_at)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT (package_id) DO UPDATE SET
		started_games = excluded.started_games,
		completed_games = excluded.completed_games,
		shown = excluded.shown,
		answered = excluded.answered,
		correct = excluded.correct,
		wrong = excluded.wrong,
		right_percent = excluded.right_percent,
		take_percent = excluded.take_percent,
		level = excluded.level,
		found = excluded.found,
		updated_at = excluded.updated_at
`);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Сверяет одно сообщение обсуждения с тем, что о нём уже записано.
 *
 * Раньше этот шаг только добавлял: увидел незнакомый файл — завёл пак, увидел
 * знакомый — прошёл мимо. Пока паки только прибывали, этого хватало; но сообщение
 * в обсуждении живое, автор его правит — дописывает, что починил, и перезаливает
 * файл. Ни то, ни другое база не замечала: на сайте оставалось первое описание
 * и первая, зачастую уже сломанная, версия пака.
 *
 * Что здесь сверяется:
 *   текст сообщения — это описание пака на карточке и часть того, по чему ищут;
 *   набор приложенных .siq — то есть сам пак.
 *
 * Чего заметить нельзя: сообщение, из которого файлы убрали все до единого.
 * Обход отдаёт только сообщения с вложениями (см. vkapi.js), и такое сообщение
 * до нас просто не доходит. Молчание тут честнее выдумки: удалённое сообщение
 * и сообщение, до которого не дошёл обход, выглядят совершенно одинаково.
 */
function syncComment(comment, useApi, tally) {
	const documents = comment.documents.filter(document => /\.siq$/i.test(document.fileName));

	if (documents.length === 0) {
		return;
	}

	const rows = knownInComment.all(comment.topicUrl, comment.id);
	const byKey = new Map(rows.map(row => [row.source_key, row]));

	// Пропавшими считаем только те файлы, которые до сих пор считались живыми.
	// Пак с мёртвой ссылкой и без того не показывается, и второй раз хоронить
	// его незачем — а вот в счёте он мешает: в сообщении, куда автор третий раз
	// перезаливает исправленный пак, «пропали два, появился один», и подмена
	// от простого исчезновения уже неотличима. Без давно похороненных остаётся
	// ровно то, что и произошло: один файл заменили другим.
	const alive = row => row.status !== 'gone' && row.status !== 'dead';
	const missing = rows.filter(row => alive(row) && !documents.some(document => document.key === row.source_key));
	const fresh = documents.filter(document => !byKey.has(document.key));
	const title = row => row.name ?? row.file_name ?? row.source_key;

	// Один файл ушёл, один пришёл — это почти наверняка не «минус пак, плюс пак»,
	// а перезалитый тот же самый: у ВК каждая загрузка получает свой номер, и по
	// номеру подмену от появления нового не отличить никак. Считаем подменой
	// и оставляем прежнюю строку — вместе с оценками, отметками «сыграно»
	// и местом в выдаче. Когда файлов больше одного, гадать нечем, и тогда
	// работает обычный разбор: чего нет — пропало, что появилось — новое.
	if (missing.length === 1 && fresh.length === 1) {
		tally.pending.push({
			kind: 'replaced',
			apply: () => rebindDocument.run(fresh[0].key, fresh[0].url, fresh[0].fileName, missing[0].id),
			say: `файл заменён: «${title(missing[0])}» -> ${fresh[0].fileName}`,
		});
	} else {
		for (const document of fresh) {
			const result = insertPackage.run(
				document.key,
				document.url,
				document.fileName,
				comment.topicUrl,
				comment.id,
				comment.author,
				comment.authorUrl,
				comment.date,
				// Через API время приходит числом, со страницы — строкой
				comment.ts ?? parseVkDate(comment.date),
				comment.text,
			);

			if (result.changes > 0) {
				tally.added++;
			}
		}

		for (const row of missing) {
			if (row.status !== 'gone') {
				tally.pending.push({
					kind: 'gone',
					apply: () => markGone.run('файл убран из сообщения обсуждения', row.id),
					say: `файл убран: «${title(row)}»`,
				});
			}
		}
	}

	for (const document of documents) {
		const row = byKey.get(document.key);

		if (!row) {
			continue;
		}

		// Убранный файл вернули на место
		if (row.status === 'gone') {
			markBack.run(row.id);
			tally.back++;
			console.log(`  файл вернулся: «${title(row)}»`);
		}

		// Ссылки из API подписаны и живут недолго — обновляем на свежую
		if (useApi) {
			refreshLink.run(document.url, document.fileName, document.key);
		}
	}

	const edited = rows.filter(row => (row.comment_text ?? '') !== comment.text);

	if (edited.length > 0) {
		const ts = comment.ts ?? parseVkDate(comment.date);

		for (const row of edited) {
			refreshComment.run(comment.text, comment.author, comment.authorUrl, comment.date, ts, row.id);
		}

		tally.edited++;
		console.log(`  сообщение переписано: «${title(edited[0])}»`);
	}
}

/**
 * Пропажи и подмены не применяются сразу, а копятся до конца обхода — и здесь
 * решается, применять ли их вообще.
 *
 * Причина недоверия простая: и то, и другое опознаётся по отсутствию — файла,
 * который мы ожидали увидеть, в сообщении нет. Ровно так же выглядит день, когда
 * ВК поменял разметку страницы, или ключ перестал давать вложения, или обход
 * оборвался на середине. Разница в числе: люди правят сообщения по одному,
 * а сломавшийся обход «теряет» сразу сотни. Поэтому обвал считается поломкой
 * обхода, а не событием в обсуждении, и база остаётся вчерашней — из неё всегда
 * можно сделать сегодняшнюю, а вот обратно уже нет.
 */
function applyPending(pending, known) {
	if (pending.length === 0) {
		return { replaced: 0, gone: 0 };
	}

	const limit = Math.max(25, Math.round(known * 0.05));

	if (pending.length > limit) {
		console.error(`Обход насчитал ${pending.length} пропавших и подменённых файлов при ${known} паках в базе — `
			+ `это больше похоже на сломавшийся обход, чем на правки в обсуждении.`);
		console.error('Ничего не меняю. Если так и есть на самом деле, повторите запуск: порог считается от размера базы.');
		return { replaced: 0, gone: 0, refused: pending.length };
	}

	const counts = { replaced: 0, gone: 0 };

	for (const change of pending) {
		change.apply();
		counts[change.kind]++;
		console.log(`  ${change.say}`);
	}

	return counts;
}

async function scanVk() {
	const useApi = hasVkApi();
	const readTopic = useApi ? readTopicApi : readTopicHtml;

	console.log(`--- Обход обсуждений ВК (${useApi ? 'через API' : 'разбором страниц, ключа нет'})`);

	const tally = { added: 0, edited: 0, back: 0, pending: [] };
	let comments = 0;

	for (const topicUrl of config.vkTopics) {
		console.log(`Тема: ${topicUrl}`);

		try {
			for await (const comment of readTopic(topicUrl, {
				maxPages,
				onPage: (page, offset, found) => console.log(`  страница ${page} (offset ${offset}): сообщений с файлами — ${found}`),
			})) {
				comments++;
				syncComment(comment, useApi, tally);
			}
		} catch (error) {
			console.error(`  ошибка обхода темы: ${error.message}`);
		}
	}

	const known = db.prepare('SELECT COUNT(*) AS c FROM packages').get().c;
	const applied = applyPending(tally.pending, known);

	console.log(`Просмотрено сообщений с файлами: ${comments}. Новых паков: ${tally.added}.`);
	console.log(`Изменений в прежних: файл заменён у ${applied.replaced}, `
		+ `переписано сообщений ${tally.edited}, убрано файлов ${applied.gone}, вернулось ${tally.back}.`);
}

const LOGO_EXTENSIONS = new Set(['.jpg', '.jpeg', '.jpe', '.jfif', '.png', '.gif', '.webp', '.bmp', '.avif']);

/**
 * Скачивает логотип пака из того же архива. Оглавление уже прочитано,
 * так что это ещё два range-запроса.
 * @returns {Promise<{file: string|null, state: string}>}
 */
async function fetchLogo(archive, logoName, packageId) {
	if (!logoName) {
		return { file: null, state: 'none' };
	}

	const entry = archive.find(`Images/${logoName}`) ?? archive.find(logoName);

	if (!entry) {
		return { file: null, state: 'none' };
	}

	if (entry.compressedSize > config.maxLogoSize) {
		return { file: null, state: 'error' };
	}

	const extension = path.extname(logoName).toLowerCase();

	if (!LOGO_EXTENSIONS.has(extension)) {
		return { file: null, state: 'error' };
	}

	const content = await archive.read(entry);
	const fileName = `${packageId}${extension}`;

	fs.mkdirSync(config.logosPath, { recursive: true });
	fs.writeFileSync(path.join(config.logosPath, fileName), content);

	return { file: fileName, state: 'ok' };
}

/** Обрыв соединения — обычное дело на больших файлах, стоит просто попробовать ещё раз. */
function isNetworkGlitch(error) {
	return /terminated|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i.test(error.message);
}

async function retryNetwork(action, attempts = 3) {
	let lastError = null;

	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			return await action();
		} catch (error) {
			lastError = error;

			if (!isNetworkGlitch(error) || attempt === attempts) {
				throw error;
			}

			await sleep(2000 * attempt);
		}
	}

	throw lastError;
}

/**
 * Ссылки ВК умирают, а полученные через API ещё и протухают по времени.
 * Если есть ключ — просим у ВК свежую ссылку и повторяем попытку один раз.
 */
async function withFreshUrl(row, action) {
	try {
		return await action(row.url);
	} catch (error) {
		if (!(error instanceof DeadLinkError) || !hasVkApi()) {
			throw error;
		}

		const fresh = await refreshDocumentUrl(row.source_key).catch(() => null);

		if (!fresh || fresh === row.url) {
			throw error;
		}

		updateUrl.run(fresh, row.id);
		return action(fresh);
	}
}

async function parsePackages() {
	const statuses = ['new'];

	if (retryFailed) {
		statuses.push('error');
	}

	if (reparse) {
		statuses.push('ok');
	}

	const placeholders = statuses.map(() => '?').join(',');

	// Пометка recheck — это перезалитые файлы: пак давно разобран и стоит «ok»,
	// но в сообщении обсуждения лежит уже другой архив (см. syncComment).
	const pending = db.prepare(`
		SELECT id, url, file_name, source_key, status FROM packages
		WHERE status IN (${placeholders}) OR recheck = 1
		ORDER BY id
	`).all(...statuses);

	const queue = pending.slice(0, limit === Infinity ? undefined : limit);

	console.log(`--- Разбор паков: в очереди ${pending.length}, будет обработано ${queue.length}`);
	progress('parse', 0, queue.length);

	let ok = 0;
	let failed = 0;
	let dead = 0;
	let logos = 0;

	for (let i = 0; i < queue.length; i++) {
		const row = queue[i];
		const label = `[${i + 1}/${queue.length}] ${row.file_name ?? row.url}`;
		progress('parse', i, queue.length);

		try {
			const result = await retryNetwork(() => withFreshUrl(row, async url => {
				const archive = await openRemoteZip(url);
				const entry = archive.find('content.xml');

				if (!entry) {
					throw new Error('в архиве нет content.xml');
				}

				const parsed = parseContentXml(await archive.read(entry));

				if (!parsed.name) {
					throw new Error('в паке не указано имя');
				}

				const logo = await fetchLogo(archive, parsed.logo, row.id).catch(() => ({ file: null, state: 'error' }));

				return { parsed, logo, totalSize: archive.totalSize };
			}));

			const { parsed, logo, totalSize } = result;

			updateParsed.run(
				parsed.name,
				JSON.stringify(parsed.authors),
				parsed.authors.join(', '),
				buildMatchKey(parsed.name, parsed.authors),
				JSON.stringify(parsed.tags),
				buildTagsKey(parsed.tags),
				parsed.authorDifficulty,
				parsed.language,
				parsed.date,
				parsed.id,
				totalSize,
				parsed.questionCount,
				parsed.roundCount,
				parsed.themeCount,
				parsed.specialCount,
				JSON.stringify(parsed.specialStat),
				JSON.stringify(parsed.contentStat),
				JSON.stringify(parsed.rounds),
				logo.file,
				logo.state,
				Date.now(),
				row.id,
			);

			saveAuthors(row.id, parsed.authors);

			ok++;

			if (logo.state === 'ok') {
				logos++;
			}

			console.log(`${label} -> «${parsed.name}», вопросов ${parsed.questionCount}, ${Math.round(totalSize / 1024 / 1024)} МБ${logo.state === 'ok' ? ', с логотипом' : ''}`);
		} catch (error) {
			const status = error instanceof DeadLinkError ? 'dead' : 'error';

			if (status === 'dead') {
				dead++;
			} else {
				failed++;
			}

			// Пак уже был разобран: временная ошибка не повод убирать его из выдачи
			if (status === 'error' && row.status === 'ok') {
				clearRecheck.run(row.id);
				console.log(`${label} -> не вышло: ${error.message}; оставляю прежний разбор`);
			} else {
				updateFailed.run(status, error.message, Date.now(), row.id);
				console.log(`${label} -> не вышло: ${error.message}`);
			}
		}
	}

	progress('parse', queue.length, queue.length);
	console.log(`Разобрано: ${ok} (логотипов ${logos}), мёртвых ссылок: ${dead}, прочих ошибок: ${failed}.`);
}

/** Догружает логотипы для паков, разобранных до появления этой возможности. */
async function fetchLogos() {
	const rows = db.prepare(`
		SELECT id, url, file_name, source_key, name FROM packages
		WHERE status = 'ok' AND (logo_state IS NULL OR logo_state = 'error')
		ORDER BY id
	`).all();

	const queue = rows.slice(0, limit === Infinity ? undefined : limit);
	console.log(`--- Логотипы: без логотипа ${rows.length}, будет обработано ${queue.length}`);
	progress('logos', 0, queue.length);

	let ok = 0;
	let none = 0;
	let failed = 0;

	for (let i = 0; i < queue.length; i++) {
		const row = queue[i];
		progress('logos', i, queue.length);

		try {
			const logo = await retryNetwork(() => withFreshUrl(row, async url => {
				const archive = await openRemoteZip(url);
				const entry = archive.find('content.xml');

				if (!entry) {
					throw new Error('в архиве нет content.xml');
				}

				const parsed = parseContentXml(await archive.read(entry));
				return fetchLogo(archive, parsed.logo, row.id);
			}));

			updateLogo.run(logo.file, logo.state, row.id);

			if (logo.state === 'ok') {
				ok++;
			} else {
				none++;
			}
		} catch (error) {
			failed++;
			updateLogo.run(null, 'error', row.id);
			console.log(`  ${row.name ?? row.file_name}: ${error.message}`);
		}

		if ((i + 1) % 25 === 0) {
			console.log(`  обработано ${i + 1}/${queue.length}`);
		}
	}

	progress('logos', queue.length, queue.length);
	console.log(`Логотипы: скачано ${ok}, в паке нет ${none}, ошибок ${failed}.`);
}

/**
 * Досчитывает спецвопросы у паков, разобранных до того, как их научились считать.
 *
 * Полный разбор сделал бы то же самое, но заодно переписал бы всё остальное
 * и заново скачал логотипы; здесь из архива читается только content.xml —
 * это пара range-запросов на пак.
 */
async function fetchSpecials() {
	const rows = db.prepare(`
		SELECT id, url, file_name, source_key, name FROM packages
		WHERE status = 'ok' AND special_count IS NULL
		ORDER BY id
	`).all();

	const queue = rows.slice(0, limit === Infinity ? undefined : limit);
	console.log(`--- Спецвопросы: не посчитаны у ${rows.length} паков, будет обработано ${queue.length}`);
	progress('specials', 0, queue.length);

	let ok = 0;
	let failed = 0;
	let found = 0;

	for (let i = 0; i < queue.length; i++) {
		const row = queue[i];
		progress('specials', i, queue.length);

		try {
			const parsed = await retryNetwork(() => withFreshUrl(row, async url => {
				const archive = await openRemoteZip(url);
				const entry = archive.find('content.xml');

				if (!entry) {
					throw new Error('в архиве нет content.xml');
				}

				return parseContentXml(await archive.read(entry));
			}));

			updateSpecials.run(parsed.specialCount, JSON.stringify(parsed.specialStat), row.id);
			ok++;

			if (parsed.specialCount > 0) {
				found++;
			}
		} catch (error) {
			failed++;
			console.log(`  ${row.name ?? row.file_name}: ${error.message}`);
		}

		if ((i + 1) % 25 === 0) {
			console.log(`  обработано ${i + 1}/${queue.length}`);
		}
	}

	progress('specials', queue.length, queue.length);
	console.log(`Спецвопросы: посчитаны у ${ok} паков, из них со спецвопросами ${found}, ошибок ${failed}.`);
}

async function refreshStats() {
	const rows = db.prepare(`
		SELECT p.id, p.name, p.authors
		FROM packages p
		WHERE p.status = 'ok' AND p.name IS NOT NULL
		ORDER BY p.id
	`).all();

	const queue = rows.slice(0, limit === Infinity ? undefined : limit);
	console.log(`--- Статистика: запрашиваю ${queue.length} паков`);
	progress('stats', 0, queue.length);

	let found = 0;
	let rated = 0;

	for (let i = 0; i < queue.length; i++) {
		const row = queue[i];
		const authors = JSON.parse(row.authors);
		progress('stats', i, queue.length);

		try {
			const raw = await fetchPackageStats(row.name, authors);

			if (!raw) {
				upsertStats.run(row.id, 0, 0, 0, 0, 0, 0, null, null, null, 0, Date.now());
			} else {
				const summary = summarize(raw);
				const level = toLevel(summary);

				if (level !== null) {
					rated++;
				}

				found++;

				upsertStats.run(
					row.id,
					summary.startedGames,
					summary.completedGames,
					summary.shown,
					summary.answered,
					summary.correct,
					summary.wrong,
					summary.rightPercent,
					summary.takePercent,
					level,
					1,
					Date.now(),
				);
			}
		} catch (error) {
			console.log(`  ${row.name}: ${error.message}`);
		}

		if ((i + 1) % 25 === 0) {
			console.log(`  обработано ${i + 1}/${queue.length}`);
		}

		await sleep(config.statsDelayMs);
	}

	progress('stats', queue.length, queue.length);
	console.log(`Статистика найдена у ${found} паков, оценку сложности получили ${rated}.`);
}

/**
 * Ошибка, после которой следующий пак получит ровно то же самое: неверный ключ,
 * неизвестная модель, кончившиеся лимиты. Признак ставит сам gemini.js; строки
 * оставлены для ошибок, пришедших не оттуда.
 */
function isFatalGeminiError(error) {
	return error.fatal === true || /ключа|API key|API_KEY|not found|permission/i.test(error.message);
}

/**
 * Кончившиеся лимиты — беда общая: если их не хватило на тематики, то и на
 * описания не хватит. Второй шаг после этого даже не начинается, вместо того
 * чтобы выяснять то же самое заново на первом же паке.
 */
let geminiQuotaSpent = false;

/**
 * Что написать, бросая шаг. Кончившиеся лимиты — это не поломка: всё, что успело
 * разметиться, уже в базе, а оставшиеся паки разберутся при следующем запуске,
 * потому что шаг и так берёт только те, у которых разметки нет (см. refreshTopics).
 */
function stopReason(error, left) {
	return error.quota === true
		? `У Gemini кончились лимиты. Пропускаю оставшиеся паки (${left}): они разберутся при следующем запуске, `
			+ 'уже размеченные заново не спрашиваются.'
		: 'Останавливаю шаг: следующий пак получит ту же ошибку.';
}

/** Раскладывает темы паков по тематикам и считает доли. */
async function refreshTopics() {
	if (!hasGemini()) {
		console.log('--- Тематики: пропускаю, нет ключа Gemini (data/gemini-key.txt или GEMINI_API_KEY)');
		return;
	}

	if (geminiQuotaSpent) {
		console.log('--- Тематики: пропускаю, лимиты Gemini кончились на предыдущем шаге');
		return;
	}

	// Разметка старее нынешних правил считается отсутствующей: доли в ней означают
	// не то же самое, что теперь (см. TOPICS_VERSION).
	const condition = retopics ? '' : `AND (p.topics_at IS NULL OR p.topics_version < ${TOPICS_VERSION})`;
	const rows = db.prepare(`
		SELECT p.id, p.name, p.rounds FROM packages p
		WHERE p.status = 'ok' AND p.rounds <> '[]' ${condition}
		ORDER BY p.id
	`).all();

	const queue = rows.slice(0, limit === Infinity ? undefined : limit);
	console.log(`--- Тематики через ${config.geminiModel}: паков без разметки ${rows.length}, будет обработано ${queue.length}`);
	progress('topics', 0, queue.length);

	// Паки, разобранные старой версией, хранят только названия тем — по ним модель угадывает плохо
	const withoutSamples = queue.filter(row => !normalizeRounds(row.rounds).some(r => r.themes.some(t => t.sample))).length;

	if (withoutSamples > queue.length / 5) {
		console.log(`    у ${withoutSamples} паков нет образцов ответов: сначала стоит выполнить node src/indexer.js --parse-only --reparse`);
	}

	let labelled = 0;
	let mixed = 0;
	let repeats = 0;

	for (let i = 0; i < queue.length; i++) {
		const row = queue[i];
		const themes = listThemes(row.id, normalizeRounds(row.rounds));
		progress('topics', i, queue.length);

		if (themes.length === 0) {
			continue;
		}

		try {
			const marks = await classifyThemes(themes);
			const { shares, questions } = computeShares(themes, marks);
			const { topic, share } = toPrimary(shares, questions);
			const franchises = computeFranchises(themes, marks);
			const top = franchises[0] ?? null;

			updateTopics.run(
				JSON.stringify(shares ?? {}),
				topic,
				share,
				JSON.stringify(franchises),
				top?.name ?? null,
				top?.share ?? null,
				Date.now(),
				row.id,
			);

			if (topic && topic !== 'mixed') {
				labelled++;
			} else if (topic === 'mixed') {
				mixed++;
			}

			if (franchises.length > 0) {
				repeats++;
			}

			const percents = Object.entries(shares ?? {})
				.filter(([key, v]) => key !== 'other' && v > 0)
				.sort((a, b) => b[1] - a[1])
				.map(([key, v]) => `${key} ${Math.round(v * 100)}%`)
				.join(', ');

			// Повторы — вторая строка: в одну с процентами они не влезают
			const repeated = franchises
				.map(f => `${f.name} ×${f.themes}`)
				.join(', ');

			console.log(`[${i + 1}/${queue.length}] «${row.name}»: ${percents || 'ничего тематического'} -> ${topic ?? 'мало вопросов'}`);

			if (repeated) {
				console.log(`      повторы: ${repeated}`);
			}
		} catch (error) {
			console.log(`[${i + 1}/${queue.length}] «${row.name}»: ${error.message}`);

			// Ключ, модель или кончившиеся лимиты — дальше будет то же самое
			if (isFatalGeminiError(error)) {
				geminiQuotaSpent = geminiQuotaSpent || error.quota === true;
				console.log(stopReason(error, queue.length - i));
				break;
			}
		}

		await sleep(config.geminiDelayMs);
	}

	progress('topics', queue.length, queue.length);
	console.log(`Тематики: ярлык получили ${labelled} паков, солянок ${mixed}, с повторами франшиз ${repeats}.`);
}

/** Просит модель описать каждый пак одной строкой: о чём он вообще. */
async function refreshSummaries() {
	if (!hasGemini()) {
		console.log('--- Описания: пропускаю, нет ключа Gemini (data/gemini-key.txt или GEMINI_API_KEY)');
		return;
	}

	if (geminiQuotaSpent) {
		console.log('--- Описания: пропускаю, лимиты Gemini кончились на предыдущем шаге');
		return;
	}

	const condition = resummary ? '' : 'AND p.summary_at IS NULL';
	const rows = db.prepare(`
		SELECT p.id, p.name, p.tags, p.rounds FROM packages p
		WHERE p.status = 'ok' AND p.rounds <> '[]' ${condition}
		ORDER BY p.id
	`).all();

	const queue = rows.slice(0, limit === Infinity ? undefined : limit);
	console.log(`--- Описания через ${config.geminiModel}: паков без описания ${rows.length}, будет обработано ${queue.length}`);
	progress('summary', 0, queue.length);

	let described = 0;

	for (let i = 0; i < queue.length; i++) {
		const row = queue[i];
		const themes = listThemes(row.id, normalizeRounds(row.rounds));
		progress('summary', i, queue.length);

		if (themes.length === 0) {
			continue;
		}

		try {
			const summary = await describePack({
				name: row.name ?? '',
				tags: jsonOrDefault(row.tags, []),
				themes,
			});

			updateSummary.run(summary || null, Date.now(), row.id);

			if (summary) {
				described++;
			}

			console.log(`[${i + 1}/${queue.length}] «${row.name}»: ${summary || 'сказать нечего'}`);
		} catch (error) {
			console.log(`[${i + 1}/${queue.length}] «${row.name}»: ${error.message}`);

			if (isFatalGeminiError(error)) {
				geminiQuotaSpent = geminiQuotaSpent || error.quota === true;
				console.log(stopReason(error, queue.length - i));
				break;
			}
		}

		await sleep(config.geminiDelayMs);
	}

	progress('summary', queue.length, queue.length);
	console.log(`Описания: получили ${described} паков.`);
}

/** Пересчитывает уровни по уже сохранённым числам — нужен после правки порогов в настройках. */
function recalcLevels() {
	const rows = db.prepare('SELECT package_id, started_games, completed_games, shown, answered, correct, wrong, right_percent, take_percent FROM stats WHERE found = 1').all();
	const update = db.prepare('UPDATE stats SET level = ? WHERE package_id = ?');

	let changed = 0;

	for (const row of rows) {
		const level = toLevel({
			startedGames: row.started_games,
			shown: row.shown,
			takePercent: row.take_percent,
			// Без доли правильных ответов пересчёт терял ступень за неточные ответы
			// и расходился с тем, что считает db.js при запуске
			rightPercent: row.right_percent,
		});

		update.run(level, row.package_id);

		if (level !== null) {
			changed++;
		}
	}

	console.log(`--- Пересчёт уровней: обработано ${rows.length}, оценку получили ${changed}`);
}

/** Пересчитывает ярлыки паков по сохранённым долям — нужен после правки порога. */
function recalcTopics() {
	const rows = db.prepare(`SELECT id, topic_shares, question_count, franchises FROM packages WHERE topics_at IS NOT NULL`).all();
	const update = db.prepare('UPDATE packages SET primary_topic = ?, primary_share = ?, franchise_top = ?, franchise_top_share = ? WHERE id = ?');

	let labelled = 0;

	for (const row of rows) {
		const shares = jsonOrDefault(row.topic_shares, null);
		const { topic, share } = toPrimary(shares, row.question_count ?? 0);

		// Сами франшизы пересчитать без модели нельзя — она называет их по темам, —
		// но какая из сохранённых главная, видно и так
		const top = jsonOrDefault(row.franchises, [])
			.filter(f => f.themes >= config.franchiseMinThemes)
			.sort((a, b) => b.questions - a.questions)[0] ?? null;

		update.run(topic, share, top?.name ?? null, top?.share ?? null, row.id);

		if (topic && topic !== 'mixed') {
			labelled++;
		}
	}

	console.log(`--- Пересчёт тематик: обработано ${rows.length}, ярлык получили ${labelled}`);
}

/** Общий пересчёт по сохранённым данным: и уровни, и ярлыки. */
function recalcAll() {
	recalcLevels();
	recalcTopics();
}

function printSummary() {
	const total = db.prepare('SELECT COUNT(*) AS c FROM packages').get().c;
	const parsed = db.prepare(`SELECT COUNT(*) AS c FROM packages WHERE status = 'ok'`).get().c;
	const errors = db.prepare(`SELECT COUNT(*) AS c FROM packages WHERE status = 'error'`).get().c;
	const deadLinks = db.prepare(`SELECT COUNT(*) AS c FROM packages WHERE status = 'dead'`).get().c;
	const gone = db.prepare(`SELECT COUNT(*) AS c FROM packages WHERE status = 'gone'`).get().c;
	const withStats = db.prepare('SELECT COUNT(*) AS c FROM stats WHERE found = 1').get().c;
	const withLogo = db.prepare(`SELECT COUNT(*) AS c FROM packages WHERE logo_state = 'ok'`).get().c;
	const described = db.prepare(`SELECT COUNT(*) AS c FROM packages WHERE summary IS NOT NULL AND summary <> ''`).get().c;
	const repeated = db.prepare(`SELECT COUNT(*) AS c FROM packages WHERE franchise_top IS NOT NULL`).get().c;
	// Спецвопросы считаются при разборе: у паков, разобранных раньше, их число неизвестно
	const specials = db.prepare(`SELECT COUNT(*) AS c FROM packages WHERE status = 'ok' AND special_count IS NULL`).get().c;
	const levels = db.prepare('SELECT level, COUNT(*) AS c FROM stats WHERE level IS NOT NULL GROUP BY level ORDER BY level DESC').all();
	const topics = db.prepare('SELECT primary_topic, COUNT(*) AS c FROM packages WHERE primary_topic IS NOT NULL GROUP BY primary_topic ORDER BY c DESC').all();

	console.log('');
	console.log('=== Итого');
	console.log(`Паков в базе: ${total} (разобрано ${parsed}, мёртвых ссылок ${deadLinks}, с ошибками ${errors}`
		+ `${gone > 0 ? `, убрано из обсуждения ${gone}` : ''})`);
	console.log(`Есть статистика: ${withStats}. С логотипом: ${withLogo}. С описанием: ${described}. С повторами франшиз: ${repeated}.`);

	if (specials > 0) {
		console.log(`Спецвопросы не посчитаны у ${specials} паков: они разобраны раньше, чем их научились считать.`);
		console.log('  Посчитать: node src/indexer.js --specials');
	}

	const names = { 4: 'лёгкий', 3: 'средний', 2: 'сложный', 1: 'очень сложный' };

	for (const level of levels) {
		console.log(`  ${names[level.level]}: ${level.c}`);
	}

	if (topics.length > 0) {
		console.log('Тематики:');

		for (const topic of topics) {
			console.log(`  ${topic.primary_topic}: ${topic.c}`);
		}
	}
}

if (has('--gemini-models')) {
	try {
		for (const model of await listModels()) {
			console.log(`${model.name.padEnd(40)} ${model.title ?? ''}`);
		}
	} catch (error) {
		console.error(`Не вышло получить список моделей: ${error.message}`);
	}

	process.exit(0);
}

/**
 * Шаги идут в этом порядке независимо от того, в каком их попросили: сначала
 * собрать и разобрать, потом уже спрашивать про них чужие сервисы.
 * Логотипы стоят после разбора, потому что разбор их и так качает, — этот шаг
 * нужен только для паков, у которых логотипа почему-то не оказалось.
 */
const STEPS = [
	{ key: 'vk', name: 'Обход обсуждений ВК', flag: '--vk-only', run: scanVk, byDefault: true },
	{ key: 'parse', name: 'Разбор паков', flag: '--parse-only', run: parsePackages, byDefault: true },
	{ key: 'stats', name: 'Статистика и сложность', flag: '--stats-only', run: refreshStats, byDefault: true },
	{ key: 'topics', name: 'Тематики и проценты', flag: '--topics-only', run: refreshTopics, byDefault: true },
	{ key: 'summary', name: 'Краткие описания', flag: '--summary-only', run: refreshSummaries, byDefault: true },
	{ key: 'logos', name: 'Логотипы', flag: '--logos', run: fetchLogos, byDefault: false },
	{ key: 'specials', name: 'Спецвопросы', flag: '--specials', run: fetchSpecials, byDefault: false },
	{ key: 'recalc', name: 'Пересчёт уровней и ярлыков', flag: '--recalc', run: recalcAll, byDefault: false },
];

/** Какие шаги делать: по флагам, по списку --steps= или, если не сказано, обычный полный проход. */
function selectedSteps() {
	const asked = new Set(text('steps').split(',').map(s => s.trim()).filter(Boolean));
	const chosen = STEPS.filter(step => asked.has(step.key) || has(step.flag));

	return chosen.length > 0 ? chosen : STEPS.filter(step => step.byDefault);
}

const steps = selectedSteps();
report({ plan: steps.map(step => ({ key: step.key, name: step.name })) });

for (const step of steps) {
	report({ step: step.key, state: 'start' });
	await step.run();
	report({ step: step.key, state: 'done' });
}

printSummary();
