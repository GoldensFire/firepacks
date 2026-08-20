// Индексатор: собирает паки из обсуждений ВК, разбирает их и подтягивает статистику.
//
//   node src/indexer.js                 полный проход
//   node src/indexer.js --vk-only       только обойти обсуждения: новое и правки
//   node src/indexer.js --parse-only    только разобрать нерасобранные паки
//   node src/indexer.js --stats-only    только обновить статистику: все паки заново
//   node src/indexer.js --stats-new     статистика и сложность только у тех, у кого их нет
//   node src/indexer.js --topics-only   только определить тематики через Gemini
//   node src/indexer.js --summary-only  только составить краткие описания паков
//   node src/indexer.js --logos         только докачать логотипы
//   node src/indexer.js --specials      досчитать спецвопросы у старых паков
//   node src/indexer.js --reparse       разобрать заново уже разобранные паки
//   node src/indexer.js --retopics      переспросить Gemini даже про уже размеченные паки
//   node src/indexer.js --resummary     переписать уже готовые описания
//   node src/indexer.js --upgrade       переспросить то, что размечено моделью слабее нынешней
//   node src/indexer.js --recalc        пересчитать уровни и ярлыки по сохранённым данным, без сети
//   node src/indexer.js --steps=a,b     явный список шагов: vk, parse, stats, statsnew, topics, summary, logos, specials, recalc
//   node src/indexer.js --model=имя     разово взять другую модель Gemini
//   node src/indexer.js --fallback      кончились суточные запросы — перейти на запасную модель
//   node src/indexer.js --gemini-models показать доступные модели Gemini
//   node src/indexer.js --gemini-usage  показать расход запросов за сегодня
//   node src/indexer.js --pages=5       ограничить число страниц обсуждения
//   node src/indexer.js --limit=20      ограничить число обрабатываемых паков
//   node src/indexer.js --jobs=8        сколько паков разбирать одновременно
//   node src/indexer.js --packs=12,34   работать только с этими паками (номера из адреса /pack/N)
//   node src/indexer.js --authors=А,Б   работать только с паками этих авторов
//   node src/indexer.js --fresh=3       только паки, выложенные за последние трое суток
//   node src/indexer.js --tail          обойти не тему целиком, а её хвост по --fresh
//   node src/indexer.js --first=virgin  чем начинать очередь: fresh (свежие, по умолчанию),
//                                       virgin (совсем неразобранные, потом самые давние),
//                                       oldest (самые давние)
//   node src/indexer.js --force         не пропускать уже сделанное: всё заново
//   node src/indexer.js --retry         попробовать заново паки с ошибками
//   node src/indexer.js --serial        по-старому: шаги друг за другом, а не разом
//
// Шаги можно сочетать: --stats-only --topics-only сделает и то, и другое.
// Тем же пользуется страница обновления базы — см. web/update.html.
//
// ————— Точечное обновление —————
//
// `--packs=` и `--authors=` сужают все шаги, кроме обхода ВК, до перечисленных
// паков: «обнови вот этот пак» и «пройди заново по пакам вот этого автора».
// Обход обсуждений при этом не идёт вовсе — искать новое в теме ради одного пака
// незачем, а других способов сузить его нет: обсуждение не спрашивают по автору.
//
// Вместе с ними обычно нужен `--force`: шаги по своему устройству берут только
// то, чего в базе ещё нет, а точечное обновление затевают как раз ради того,
// чтобы переделать уже сделанное. Один ключ вместо четырёх галочек — та же
// «переделать заново», но сразу везде.
//
// ————— Почему шаги идут разом —————
//
// Раньше проход был лесенкой: обойти ВК, потом разобрать паки, потом статистика,
// потом Gemini. Каждая ступень ждала предыдущую целиком, и почти всё это время
// ничего не происходило — каждый шаг упирается в ожидание своего собеседника
// и ничем не мешает остальным. Обход ВК занимает канал на десяток минут, статистика
// стучится на vladimirkhil.com, Gemini считает своё, разбор ходит в хранилище ВК.
// Общего у них — только база, а она своя, местная и мгновенная.
//
// Теперь шаги — не ступени, а полосы: все начинаются сразу и разбирают работу
// по мере её появления. Пак, найденный в обсуждении на второй минуте, тут же
// уходит в разбор; разобранный — тут же в статистику и к модели. Полоса, у которой
// работа кончилась, не заканчивается, пока может прибыть новая: она ждёт и берёт
// добавку (см. drain). Ключ --serial возвращает прежний порядок — иногда нужно
// именно по одному, чтобы разглядеть, что происходит.

import fs from 'node:fs';
import path from 'node:path';
import {
	config, TOPICS_VERSION, PROGRESS_PREFIX, OTHER_KINDS, GENRES, FORMS, ORIGINS,
	LANGUAGE_NAMES, decadeName,
} from './config.js';
import {
	db, buildMatchKey, buildTagsKey, buildAuthorKey, saveAuthors, parseVkDate, normalizeRounds,
	jsonOrDefault, repeatShare,
} from './db.js';
import { readTopic as readTopicHtml } from './vk.js';
import { readTopic as readTopicApi, readTopicSince, hasVkApi, refreshDocumentUrl } from './vkapi.js';
import { openRemoteZip, DeadLinkError } from './zip.js';
import { parseContentXml } from './siq.js';
import { fetchPackageStats, summarize, toLevel } from './stats.js';
import { hasGemini, classifyThemes, describePack, analyzePacks, listModels, useModel, activeModel, tokensLine } from './gemini.js';
import { MODELS, modelRank, usage, usageLine, usageReport, nextSpareModel } from './models.js';
import {
	listThemes, computeShares, toPrimary, computeFranchises, computeAreas, computeOtherKinds,
	computeGenres, computeForms, computeDecades, computeOrigin,
} from './topics.js';
import { isCategoryName } from './franchise.js';
import { ensureThumb } from './thumbs.js';
import { thumbName } from './settings.js';

const args = process.argv.slice(2);
const has = flag => args.includes(flag);
const text = name => args.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? '';
const value = (name, fallback) => {
	const found = text(name);
	return found ? Number(found) : fallback;
};

/**
 * «Переделать всё заново» одним ключом. Каждая из четырёх галочек существует
 * и по отдельности — обычный ночной обход ими и пользуется поодиночке, — а этот
 * ключ для другого случая: когда паки названы поимённо и переспрашивается всё,
 * что про них известно (см. --packs выше).
 */
const force = has('--force');

const reparse = has('--reparse') || force;
const retopics = has('--retopics') || force;
const resummary = has('--resummary') || force;
const retryFailed = has('--retry') || force;
const upgrade = has('--upgrade');
const serial = has('--serial');
const maxPages = value('pages', Infinity);
const limit = value('limit', Infinity);

/**
 * `--tail`: обойти не тему целиком, а только её хвост — сообщения не старше
 * отсечки свежести (см. --fresh ниже и readTopicSince в vkapi.js).
 *
 * Отдельным ключом, а не само собой при `--fresh`, и это не мелочь. Обход темы
 * целиком делает две работы разом: находит новое и замечает, что в старом
 * сообщении подменили или убрали файл. Вторая работа возможна только у того,
 * кто прочитал тему до конца, — и делать её должен кто-то. Ночь читает всю тему
 * и делает обе; ежечасный обход берёт этот ключ и делает одну, зато за секунды
 * вместо десяти минут (см. .github/workflows/hourly.yml).
 */
const tail = has('--tail');

/**
 * Сколько паков разбирать одновременно.
 *
 * Разбор пака — это не скачивание, а несколько коротких запросов вглубь архива:
 * оглавление, content.xml, логотип. Байт в них полторы сотни килобайт на пак,
 * но каждый поход к хранилищу ВК стоит от полусекунды до трёх секунд сам по себе,
 * сколько бы ни просили. Поэтому один пак в одиночку идёт секунд пять-десять,
 * и всё это время канал простаивает: ждём ответа, а не качаем.
 *
 * Отсюда и способ ускорения — не быстрее качать, а ждать нескольких сразу.
 * Замер на живых паках: десять хвостов подряд — 4.5 с на штуку, те же десять
 * разом — 0.96 с на штуку.
 */
const jobs = Math.max(1, value('jobs', config.parseJobs));

/** Модель на этот запуск: --model= перебивает выбранную на странице обновления. */
if (text('model')) {
	useModel(text('model'));
}

/**
 * Разрешено ли посреди работы перейти на запасную модель, когда у нынешней
 * кончились суточные запросы (см. nextSpareModel в models.js).
 *
 * Ключом, а не всегда, потому что случая тут два разных. Ночной обход идёт сам,
 * смотреть за ним некому, и упереться в лимит на середине очереди для него —
 * обычное дело: там переход на соседнюю Lite означает несколько лишних тысяч
 * размеченных паков вместо «продолжим завтра». Запуск руками со страницы
 * обновления — другое: там модель выбрана человеком нарочно, и подменять её
 * молча нельзя, иначе выбор ничего не значит.
 *
 * Ключ ставит ночной обход сам (см. scripts/nightly.js).
 */
const fallback = has('--fallback');

/**
 * Сколько минут работе отпущено. Ноль — сколько угодно, как было всегда.
 *
 * Это не ограничение ради ограничения, а способ доделать работу до конца.
 * Обход не кончается сам: очередь в базе на тысячи паков, а размечается она
 * сотнями, и всякий полный проход упирается либо в лимиты Gemini, либо в чужое
 * терпение. В облаке терпение измеримо — GitHub убивает работу на шести часах,
 * и убивает грубо: не «доделай и выйди», а обрыв посреди запроса. Дальше
 * не выполняется ничего: ни выкладка, ни отчёт. Две ночи подряд (16 и 17 августа
 * 2026) так и прошли — по пять с лишним часов разметки, около двух тысяч
 * размеченных паков за ночь, и ни один из них не доехал до сайта, потому что
 * шаг выкладки стоит ПОСЛЕ обхода, а до него дело не дошло.
 *
 * Срок решает это целиком. Индексатор смотрит на часы там же, где смотрит
 * на кончившиеся лимиты (см. drain), и по истечении времени доводит начатое
 * до конца и выходит с успехом — а ночь спокойно идёт дальше, к выкладке.
 * Сделано меньше, зато сделанное — на сайте.
 */
const minutesLeft = value('minutes', 0);
const finishBy = minutesLeft > 0 ? Date.now() + minutesLeft * 60_000 : null;

/** Кончилось ли отпущенное время. Проверяется на каждом круге очереди. */
let timeUp = false;

function outOfTime() {
	if (!finishBy || timeUp) {
		return timeUp;
	}

	if (Date.now() >= finishBy) {
		timeUp = true;
		say('time', `отпущенные ${minutesLeft} мин вышли: доделываю начатое и заканчиваю. `
			+ 'Оставшаяся очередь никуда не денется — её возьмёт следующий обход.');
	}

	return timeUp;
}

/**
 * Паки, названные поимённо: `--packs=128,340`. Номер — тот же, что в адресе
 * страницы пака (/pack/128-...), поэтому ссылку можно просто вставить целиком:
 * всё, что не число, отсеивается.
 */
const onlyPacks = text('packs')
	.split(/[^0-9]+/)
	.map(part => Number.parseInt(part, 10))
	.filter(id => Number.isFinite(id) && id > 0);

/**
 * Авторы, чьи паки разбираются.
 *
 * Их два списка, и делают они разное. `--authors=Имя,Имя` — разовый: очередь
 * состоит только из паков этих авторов, всё остальное шаг не трогает вовсе.
 * `config.priorityAuthors` — постоянный: очередь остаётся полной, но паки
 * перечисленных авторов встают в её начало. Нужны оба: первым догоняют одного
 * автора здесь и сейчас, вторым решают, кем каждую ночь начинать.
 *
 * Имена сводятся к ключу тем же правилом, что и в таблице pack_authors, —
 * иначе «Кот» и «кот» оказались бы разными людьми.
 */
const onlyAuthors = text('authors').split(',').map(name => buildAuthorKey(name)).filter(Boolean);
const priorityAuthors = (config.priorityAuthors ?? []).map(name => buildAuthorKey(name)).filter(Boolean);

/** Названы ли паки поимённо. От этого зависит, что вообще делать в этот запуск. */
const targeted = onlyPacks.length > 0 || onlyAuthors.length > 0;

/**
 * Только недавно выложенное: `--fresh=3` — паки, появившиеся в обсуждении
 * за последние трое суток.
 *
 * Ради ночного обхода (см. scripts/nightly.js). Ночь идёт двумя проходами:
 * сперва короткий — обойти обсуждения и разобрать всеми средствами то, что
 * выложили на днях, — и лишь потом длинный, по всей остальной базе. Разница
 * не в объёме работы, а в том, что случится, когда её прервут: суточный лимит
 * Gemini кончается посреди ночи всегда, и без этого прохода сегодняшний пак мог
 * упереться в него наравне с трёхлетним. Теперь свежее сделано ещё до того, как
 * начато остальное.
 *
 * От `--packs` отличается тем, что не отменяет обход ВК: новые паки в базе
 * берутся именно оттуда, и в первом проходе обход и есть главное.
 *
 * Свежесть меряется по дате сообщения (vk_ts), а не по времени попадания в базу:
 * пак, найденный сегодня в старой теме, новым не является — он просто не попадался
 * раньше, и разбирать его вне очереди незачем.
 */
const freshDays = value('fresh', 0);
const freshSince = freshDays > 0 ? Date.now() - freshDays * 86_400_000 : null;

/**
 * Кусок WHERE, сужающий шаг до названных паков. Общий для всех шагов, работающих
 * с паками: и разбора, и статистики, и модели — иначе «обнови вот этот пак»
 * означало бы обновить у него одну только разметку.
 *
 * @param {string} alias как назван packages в этом запросе
 */
function targetSql(alias = 'p') {
	const parts = [];
	const params = [];

	// Отсечка по свежести стоит отдельным условием, а не в общем ИЛИ ниже:
	// «свежие» — это сужение, а не ещё один способ назвать паки. Вместе
	// с `--packs` она означала бы «названные, и притом свежие», но вместе их
	// никто не задаёт, а разбирать этот случай отдельно незачем
	const fresh = freshSince === null
		? ''
		: ` AND ${alias}.vk_ts IS NOT NULL AND ${alias}.vk_ts >= ${freshSince}`;

	if (onlyPacks.length > 0) {
		parts.push(`${alias}.id IN (${onlyPacks.map(() => '?').join(',')})`);
		params.push(...onlyPacks);
	}

	if (onlyAuthors.length > 0) {
		parts.push(`EXISTS (SELECT 1 FROM pack_authors a WHERE a.package_id = ${alias}.id
			AND a.author_key IN (${onlyAuthors.map(() => '?').join(',')}))`);
		params.push(...onlyAuthors);
	}

	// Названы и паки, и авторы — берём и тех, и других, а не общее у них.
	// Пересечение здесь почти всегда пусто: номера выписывают из одного места,
	// имена вспоминают из другого, и «обнови вот эти три пака и заодно всё
	// вот этого автора» — единственное, чем такая пара бывает на самом деле
	return { where: (parts.length > 0 ? ` AND (${parts.join(' OR ')})` : '') + fresh, params };
}

/**
 * Кусок ORDER BY: сначала самые свежие паки.
 *
 * Свежесть — это дата сообщения в обсуждении (vk_ts), а не номер строки: номера
 * раздаются в порядке обхода обсуждений, и первым в базу попадает не самый новый
 * пак, а первый попавшийся. Паки без даты идут в самом конце: узнать про них
 * нечего, и ждать своей очереди они могут сколько угодно.
 *
 * Почему именно так. Работа упирается в суточный лимит и в неё же не влезает:
 * очередь до конца не проходится никогда, и вопрос лишь в том, что останется
 * недоделанным. Пусть это будет позавчерашнее, а не сегодняшнее — новый пак,
 * выложенный вечером, нужен на сайте наутро, а не через неделю.
 *
 * Номер строки стоит вторым ключом и нужен только для устойчивости: без него две
 * строки одной даты могли бы меняться местами между запусками, и прерванный
 * на середине шаг начинал бы не с того места, на котором остановился.
 */
const NEWEST_FIRST = 'p.vk_ts IS NULL, p.vk_ts DESC, p.id DESC';

/** То же самое с другого конца: сначала самое давнее. */
const OLDEST_FIRST = 'p.vk_ts IS NULL, p.vk_ts ASC, p.id ASC';

/**
 * Про кого база не знает вообще ничего.
 *
 * Ноль у пака, которого не касались ни разу: ни разметки, ни описания,
 * ни найденной статистики. Единица у всех остальных. Отсюда и «сначала пустые»
 * — обычным ASC.
 *
 * Зачем такой порядок нужен рядом с «сначала свежие». Очередь до конца
 * не проходится никогда: суточного лимита хватает на несколько сотен паков,
 * а нерасмеченных бывают тысячи. Свежесть — хороший порядок, пока база
 * догоняет сегодняшний день, но у неё есть и хвост: паки, до которых очередь
 * не дошла ни разу за всё время, и на карточке у них пусто совершенно — ни
 * процентов, ни описания, ни уровня сложности. Такой пак на сайте выглядит
 * не «пока не размеченным», а сломанным, и одна ночь этим порядком закрывает
 * их сотнями.
 *
 * Внутри и пустых, и остальных порядок дальше идёт от давнего к свежему,
 * и это не мелочь второго ключа, а суть этого порядка. Раньше вторым ключом
 * стояла свежесть, и очередь на каждой пачке начиналась заново с новых паков:
 * очередь перебирается не один раз, а на каждой пачке заново (см. drain),
 * а обход ВК в это же время подносит только что выложенное — и каждый такой
 * пак приходил в самое начало пустых, отодвигая хвост, ради которого порядок
 * и выбирают. Со свежими и так есть кому разобраться: это обычный порядок,
 * стоящий первым в списке.
 */
const NOTHING_KNOWN = `(CASE WHEN p.topics_at IS NULL AND p.summary_at IS NULL
	AND NOT EXISTS (SELECT 1 FROM stats s WHERE s.package_id = p.id AND s.found = 1)
	THEN 0 ELSE 1 END)`;

/**
 * Второй ключ того же порядка: у кого этого шага не было ни разу.
 *
 * NOTHING_KNOWN отвечает на вопрос про всю карточку целиком, и этого мало. В очередь
 * шага встают не только нетронутые паки, но и давно размеченные — те, у кого разметка
 * старее нынешних правил или сделана моделью послабее (см. TOPICS_VERSION
 * и weakerModelSql). Для NOTHING_KNOWN и те и другие одинаковы: раз пак хоть чем-то
 * заполнен, он в общей куче, а дальше решает дата — и переразметка позавчерашнего
 * пака обгоняла пак, у которого разметки нет вообще. То есть работа уходила на то,
 * что на сайте и так показано, вместо того, где пусто.
 *
 * Отсюда отдельный ключ у каждого шага: «версии нет» идёт впереди «версия старая».
 * Пишется как `... IS NOT NULL`: у нетронутого пака выходит 0, и обычный ASC ставит
 * его первым — так же, как `p.vk_ts IS NULL` в порядке по свежести.
 */
const NEVER = {
	topics: 'p.topics_at IS NOT NULL',
	summary: 'p.summary_at IS NOT NULL',
	// Общий шаг спрашивает про разметку и описание одним запросом (см. refreshAnalysis),
	// и нетронутый для него тот, у кого нет ни того, ни другого
	analyze: '(p.topics_at IS NOT NULL OR p.summary_at IS NOT NULL)',
};

/**
 * Чем начинать очередь: `--first=fresh|virgin|oldest`.
 *
 * Порядок решает всё, потому что очередь не проходится до конца (см. NEWEST_FIRST):
 * вопрос не в том, что будет сделано, а в том, что останется несделанным.
 *
 * @param {string} [step] шаг, для которого строится очередь: от него зависит,
 *   что считать нетронутым паком (см. NEVER)
 */
function orderSql(step) {
	if (firstOrder !== 'virgin') {
		return firstOrder === 'oldest' ? OLDEST_FIRST : NEWEST_FIRST;
	}

	const never = Object.hasOwn(NEVER, step) ? `${NEVER[step]}, ` : '';

	return `${NOTHING_KNOWN}, ${never}${OLDEST_FIRST}`;
}

const ORDER_NAMES = {
	fresh: 'сначала свежие',
	virgin: 'сначала совсем неразобранные, потом ни разу не считанные, потом самые давние',
	oldest: 'сначала самые давние',
};

const firstOrder = Object.hasOwn(ORDER_NAMES, text('first')) ? text('first') : 'fresh';

/**
 * То же самое, но постоянно избранные авторы идут впереди всех (см. priorityAuthors).
 * Внутри избранных порядок такой же, какой выбран ключом --first.
 */
function priorityOrderSql(step) {
	const order = orderSql(step);

	if (priorityAuthors.length === 0) {
		return { order, params: [] };
	}

	return {
		order: `(SELECT 1 FROM pack_authors a WHERE a.package_id = p.id
			AND a.author_key IN (${priorityAuthors.map(() => '?').join(',')})) IS NULL, ${order}`,
		params: [...priorityAuthors],
	};
}

/** Что написать в шапке шага про отбор паков. */
function queueNote(withPriority = true) {
	const parts = [];

	if (onlyPacks.length > 0) {
		parts.push(`только паки ${onlyPacks.join(', ')}`);
	}

	if (onlyAuthors.length > 0) {
		parts.push(`только авторы: ${text('authors')}`);
	}

	if (freshSince !== null) {
		parts.push(`только выложенное за ${freshDays} ${freshDays === 1 ? 'сутки' : 'суток'}`);
	}

	if (withPriority && priorityAuthors.length > 0) {
		parts.push(`сначала ${config.priorityAuthors.join(', ')}`);
	}

	// Порядок очереди называется всегда, кроме обычного: по логу должно быть
	// видно, почему шаг взялся не за сегодняшние паки
	if (withPriority && firstOrder !== 'fresh') {
		parts.push(ORDER_NAMES[firstOrder]);
	}

	return parts.length > 0 ? ` (${parts.join('; ')})` : '';
}

/**
 * Условие «размечено моделью слабее нынешней» для ключа --upgrade.
 *
 * Ради него и заведены колонки topics_model и summary_model. Порядок работы, под
 * который это сделано: сначала всю базу проходит лёгкая модель — быстро, дёшево
 * и с неизбежными огрехами, — а потом день за днём то же самое переспрашивается
 * у модели посильнее, у которой суточных запросов два десятка. Без пометки, чем
 * размечен пак, второй проход пришлось бы делать вслепую: либо переспрашивать всё
 * подряд, включая уже хорошее, либо не переспрашивать ничего.
 *
 * Пустая пометка считается слабой разметкой: так помечены паки, размеченные до
 * появления колонок, и что там была за модель, теперь уже не узнать.
 *
 * @param {string} column topics_model или summary_model
 */
function weakerModelSql(column) {
	const rank = modelRank(activeModel());
	const weaker = MODELS.filter(model => model.rank < rank).map(model => model.id);
	const params = [];

	if (!upgrade) {
		return { where: '', params };
	}

	let where = ` OR p.${column} IS NULL`;

	if (weaker.length > 0) {
		where += ` OR p.${column} IN (${weaker.map(() => '?').join(',')})`;
		params.push(...weaker);
	}

	return { where, params };
}

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

/** Человеческая запись длительности: «2 ч 05 мин», «14 мин», «40 с». */
function formatSpan(ms) {
	if (ms === null || !Number.isFinite(ms)) {
		return '';
	}

	const seconds = Math.round(ms / 1000);

	if (seconds < 90) {
		return `${seconds} с`;
	}

	const minutes = Math.round(seconds / 60);

	if (minutes < 90) {
		return `${minutes} мин`;
	}

	return `${Math.floor(minutes / 60)} ч ${String(minutes % 60).padStart(2, '0')} мин`;
}

/**
 * Счётчик одного шага: сколько сделано, сколько всего и когда это кончится.
 *
 * Всего — величина не постоянная: пока идёт обход ВК, у разбора прибывает работа,
 * а у статистики она прибывает от разбора. Поэтому «всего» не задаётся вперёд,
 * а растёт (см. expand), и остаток времени считается по нынешнему темпу: сколько
 * ушло на сделанное, столько же в среднем уйдёт на каждое оставшееся.
 *
 * Темп берётся не за всё время, а за последнее: у разбора первые паки идут
 * вперемешку с обходом ВК и медленнее, чем потом, и средняя за весь шаг обещала
 * бы вдвое больше правды.
 */
class Track {
	constructor(step) {
		this.step = step;
		this.total = 0;
		this.done = 0;
		this.issued = 0;
		this.reported = 0;
		this.startedAt = Date.now();
		this.marks = [];
		this.lastSent = 0;
		this.growing = false;
	}

	/**
	 * Номер для строки лога. Считается по выданным, а не по законченным: работники
	 * идут вшестером, и «сделано» у них в один миг одно и то же — шесть строк
	 * подряд с одинаковым номером.
	 */
	label() {
		return `${++this.issued}/${this.total}`;
	}

	/**
	 * Пора ли писать в лог очередное «столько-то из стольких».
	 *
	 * Не просто остаток от деления: работников несколько, и в тот миг, когда
	 * сделано ровно сотня, спросить об этом успевают все четверо — в логе выходило
	 * четыре одинаковых строки подряд.
	 */
	milestone(every) {
		if (this.done > 0 && this.done - this.reported >= every) {
			this.reported = this.done;
			return true;
		}

		return false;
	}

	expand(count) {
		this.total += count;
		this.send(true);
	}

	tick(count = 1) {
		this.done += count;
		this.marks.push([Date.now(), this.done]);

		// Хвоста в две сотни отметок хватает, чтобы сгладить случайный долгий пак
		// и при этом не помнить о том, как шаг разгонялся полчаса назад
		if (this.marks.length > 200) {
			this.marks.splice(0, this.marks.length - 200);
		}

		this.send();
	}

	/** Сколько осталось, миллисекунды. Пусто, пока считать не из чего. */
	get etaMs() {
		const left = this.total - this.done;

		if (left <= 0 || this.marks.length < 2) {
			return null;
		}

		const [firstAt, firstDone] = this.marks[0];
		const [lastAt, lastDone] = this.marks.at(-1);
		const span = lastAt - firstAt;
		const made = lastDone - firstDone;

		if (span <= 0 || made <= 0) {
			return null;
		}

		return Math.round((span / made) * left);
	}

	/** Хвост строки для консоли: «1200/4885, осталось ~14 мин». */
	get line() {
		const eta = this.etaMs;
		return `${this.done}/${this.total}${eta ? `, осталось ~${formatSpan(eta)}` : ''}`;
	}

	send(force = false) {
		const now = Date.now();

		// Полоска выполнения на странице не станет честнее от сотни сообщений
		// в секунду, а стоят они настоящих байтов в трубе
		if (!force && now - this.lastSent < 250) {
			return;
		}

		this.lastSent = now;
		report({ step: this.step, done: this.done, total: this.total, eta: this.etaMs, growing: this.growing });
	}

	finish() {
		this.send(true);
		report({ step: this.step, state: 'done' });
	}
}

const tracks = new Map();
const track = step => tracks.get(step);

/** Строка в лог от имени шага: полосы идут вперемешку, и без подписи их не разобрать. */
const TAGS = {
	vk: 'ВК',
	parse: 'разбор',
	stats: 'статистика',
	statsnew: 'статистика новых',
	topics: 'тематики',
	summary: 'описания',
	analyze: 'разметка',
	logos: 'логотипы',
	specials: 'спецвопросы',
	recalc: 'пересчёт',
	// Не шаг, а весь обход разом: строка про то, что отпущенное время вышло
	// и очередь досрочно свёрнута (см. --minutes)
	time: 'время',
};

const say = (step, line) => console.log(`[${TAGS[step]}] ${line}`);

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

/** Есть ли такой документ в базе вообще — хоть под этим сообщением, хоть под другим. */
const knownDocument = db.prepare('SELECT id FROM packages WHERE source_key = ?');

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
		franchises = ?, franchise_top = ?, franchise_top_share = ?, repeat_share = ?, other_kinds = ?,
		genres = ?, genre_topic = ?,
		forms = ?, form_topic = ?, form_coverage = ?,
		decades = ?, decade_coverage = ?, origins = ?, origin_coverage = ?,
		topics_at = ?, topics_model = ?, topics_version = ${TOPICS_VERSION} WHERE id = ?
`);

const updateSummary = db.prepare(`
	UPDATE packages SET summary = ?, summary_at = ?, summary_model = ?,
		audience_from = ?, audience_to = ?, audience_male = ?, audience_at = ?,
		language_ai = COALESCE(?, NULLIF(language_ai, ''), '') WHERE id = ?
`);

/**
 * Записывает ответ модели про весь пак: описание и оценку аудитории.
 *
 * Обе вещи приезжают одним ответом (см. describePack и analyzePack), и пишутся
 * тоже разом. Отметка audience_at ставится и тогда, когда аудитории в ответе
 * не оказалось: спросили — значит, спросили, и переспрашивать каждую ночь
 * незачем.
 *
 * Так же и с языком, только отметка у него своя же колонка. NULL в language_ai
 * значит «ещё не спрашивали» — по нему пак и попадает в очередь; пустая строка
 * значит «спросили, а модель промолчала», и второй раз он в очередь не встаёт.
 * Сайту пустая строка и NULL — одно и то же: и там, и там он берёт язык
 * из файла (см. LANG_SQL в cf/src/library.js).
 */
function saveSummary(row, model, summary, audience, language = null) {
	updateSummary.run(
		summary || null,
		Date.now(),
		model,
		audience?.from ?? null,
		audience?.to ?? null,
		audience?.male ?? null,
		Date.now(),
		// Промолчавшая про язык модель не должна стирать прошлый ответ: язык
		// у пака один и тот же от разбора к разбору, а «не сказала» — это
		// не «языка нет». Зато пустую строку она ставит, и это отметка
		// «спрашивали» (COALESCE в самом запросе)
		language,
		row.id,
	);
}

/** Аудитория строкой для лога: «18–25 лет, М 70% / Ж 30%». */
const audienceLine = audience => (audience
	? `${audience.from}–${audience.to} лет, М ${audience.male}% / Ж ${100 - audience.male}%`
	: 'аудитория не названа');

/**
 * Язык пака строкой для лога: «язык: Русский (ru), в файле en-US».
 *
 * Строка эта нужна не для полноты отчёта. Язык — единственное, что модель
 * называет ВОПРЕКИ файлу: поле в самом паке ставит редактор, и стоит в нём
 * то, какая у автора Windows, — по нему английских паков в базе выходило
 * больше, чем их есть на свете (см. LANGUAGE_RULES в gemini.js). Пока в логе
 * этого не было, проверить, не выдумывает ли модель, было нечем: в базе лежит
 * итог, а от чего он отличается — не видно. Поэтому рядом стоит и то,
 * что записано в файле: расхождение и есть весь смысл этой строки.
 *
 * Промолчавшая модель называется вслух тоже: пустая строка от неё значит
 * «спросили, а ответа нет», и молча пропускать это в логе нельзя — иначе
 * пак без языка выглядит паком, про который не спрашивали.
 */
const languageLine = (language, fromFile) => {
	const own = fromFile ? `, в файле ${fromFile}` : ', в файле не указан';

	return language
		? `язык: ${LANGUAGE_NAMES[language] ?? language} (${language})${own}`
		: `язык: модель не назвала${own}`;
};
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
	//
	// Оговорка про «этого документа больше нигде нет»: тот же файл нередко висит
	// сразу в двух сообщениях, и переселить строку на чужой ключ значит наткнуться
	// на запрет повторов в базе. Раньше это роняло весь обход темы целиком —
	// вместе с тысячами ещё не прочитанных сообщений.
	const takenElsewhere = fresh.length === 1 && knownDocument.get(fresh[0].key) !== undefined;

	if (missing.length === 1 && fresh.length === 1 && !takenElsewhere) {
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
			say('vk', `файл вернулся: «${title(row)}»`);
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
		say('vk', `сообщение переписано: «${title(edited[0])}»`);
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

	const ceiling = Math.max(25, Math.round(known * 0.05));

	if (pending.length > ceiling) {
		console.error(`Обход насчитал ${pending.length} пропавших и подменённых файлов при ${known} паках в базе — `
			+ `это больше похоже на сломавшийся обход, чем на правки в обсуждении.`);
		console.error('Ничего не меняю. Если так и есть на самом деле, повторите запуск: порог считается от размера базы.');
		return { replaced: 0, gone: 0, refused: pending.length };
	}

	const counts = { replaced: 0, gone: 0 };

	for (const change of pending) {
		change.apply();
		counts[change.kind]++;
		say('vk', change.say);
	}

	return counts;
}

/**
 * Насколько раньше отсечки свежести начинать читать хвост темы.
 *
 * Отсечка считается от нынешнего мига (`--fresh=1` — сутки назад), а пак попадает
 * в тему тогда, когда его выложили. Между тем и другим лежат все обычные
 * неурядицы: пропущенный по расписанию запуск, обход, отложенный очередью,
 * сообщение, у которого дата правки моложе даты выкладки. Лишние сутки хвоста
 * стоят одного-двух запросов к ВК, а сужать их до точности незачем: отбирает
 * свежие паки всё равно не обход, а условие по vk_ts (см. targetSql).
 */
const TAIL_MARGIN_MS = 86_400_000;

async function scanVk() {
	const useApi = hasVkApi();

	// Хвостом читается тема тогда, когда об этом попросили ключом и когда есть
	// от чего считать хвост. Без ключа ВК так нельзя вовсе: разбор страниц темы
	// с конца читать не умеет
	const tailOnly = tail && useApi && freshSince !== null;
	const readTopic = !useApi
		? readTopicHtml
		: tailOnly
			? (url, options) => readTopicSince(url, freshSince - TAIL_MARGIN_MS, options)
			: readTopicApi;

	say('vk', `обход обсуждений (${useApi ? 'через API' : 'разбором страниц, ключа нет'}`
		+ `${tailOnly ? `, только хвост — сообщения за последние ${freshDays + 1} суток` : ''})`);

	const tally = { added: 0, edited: 0, back: 0, pending: [] };
	const bar = track('vk');
	let comments = 0;
	let skipped = 0;
	let broken = 0;
	let unreadable = 0;
	let gaps = 0;

	for (const topic of config.vkTopics) {
		const topicUrl = topic.url;

		// Полночь по Москве: сама тема часового пояса не знает, а сообщения
		// сравниваются с отсечкой по фактическому моменту, а не по строке даты.
		const cutoff = topic.before ? Date.parse(`${topic.before}T00:00:00+03:00`) : null;

		say('vk', `тема ${topicUrl}${topic.before ? ` (паки до ${topic.before})` : ''}`);

		// Сколько сообщений в теме, ВК говорит в первом же ответе — по нему
		// и растёт полоска выполнения, а заодно видно, дочитали ли до конца
		let announced = null;
		let read = 0;

		try {
			for await (const comment of readTopic(topicUrl, {
				maxPages,
				// Сообщение, на котором спотыкается сам ВК. Его пропускают, чтобы
				// прочитать всё остальное; пак под ним, если он там был, найдётся
				// только когда ВК починится (см. readWindow в vkapi.js)
				onSkip: at => {
					unreadable++;
					say('vk', `сообщение на месте ${at} прочитать нечем: ВК отвечает внутренней ошибкой. Иду дальше.`);
				},

				// Кусок темы, который ВК так и не отдал (пустой ответ и после
				// повторов). Тему это не обрывает — обход шагает дальше, — но
				// до сотни сообщений остались непрочитанными, и хоронить по такому
				// обходу пропавшие файлы нельзя: см. ниже, где считается applied.
				onGap: (at, size) => {
					gaps++;
					console.error(`[ВК] кусок темы с места ${at} (до ${size} сообщений) ВК не отдал даже после повторов. `
						+ 'Перешагиваю; непрочитанное подберётся следующим обходом.');
				},
				onPage: page => {
					// Сколько сообщений в теме, ВК называет сразу — с этого и растёт
					// полоска. Полоса обхода считает прочитанные сообщения, а не
					// найденные паки: паки попадаются далеко не в каждом сообщении,
					// и по ним не видно, много ли осталось.
					// Число это не каменное: пока идёт обход, в теме и пишут, и удаляют.
					// Берём всегда последнее сказанное, а полоску растим на разницу
					if (page.total !== null) {
						bar.expand(Math.max(0, page.total - (announced ?? 0)));
						announced = page.total;
					}

					bar.tick(Math.max(0, page.read - read));
					read = page.read;

					if (page.page % 25 === 0) {
						say('vk', `прочитано ${page.read}${page.total ? ` из ${page.total}` : ''} сообщений`
							+ `${bar.etaMs ? `, осталось ~${formatSpan(bar.etaMs)}` : ''}`);
					}
				},
			})) {
				comments++;

				if (cutoff !== null) {
					const ts = comment.ts ?? parseVkDate(comment.date);

					if (ts === null || ts >= cutoff) {
						skipped++;
						continue;
					}
				}

				syncComment(comment, useApi, tally);
			}

			// Тему дочитали не до конца — и это не мелочь, а ровно тот случай,
			// из-за которого в базе не хватало семи тысяч паков: обход обрывался
			// на середине и молча объявлял, что всё собрано.
			//
			// Недобор в пару сообщений тревогой не считается: пока идёт обход,
			// в теме удаляют, и отсчёт под нами сдвигается сам собой. Страница —
			// та мера, ниже которой это точно не поломка.
			if (!tailOnly && announced !== null && announced - read > 100 && maxPages === Infinity) {
				broken++;
				console.error(`[ВК] тема прочитана не до конца: ${read} сообщений из ${announced}. `
					+ 'Собранное осталось в базе, недочитанное подберётся следующим обходом.');
			}
		} catch (error) {
			broken++;
			console.error(`[ВК] обход темы оборвался на ${read} сообщении: ${error.message}`);
			console.error('[ВК] Собранное до обрыва осталось в базе; остальное подберёт следующий обход.');
		}
	}

	const known = db.prepare('SELECT COUNT(*) AS c FROM packages').get().c;

	// Недочитанный обход не имеет права никого хоронить: «файла в сообщении нет»
	// и «до сообщения не дошли» выглядят одинаково, а разница в цене — целая база.
	//
	// Обход хвоста неполон всегда и по своему устройству: старой части темы он
	// не видел вовсе. Это не поломка, а его назначение — и потому он поставлен
	// сюда же, рядом с обрывом: судить о пропавших файлах ему нечем ровно так же
	const incomplete = broken > 0 || gaps > 0 || tailOnly;

	const applied = incomplete
		? { replaced: 0, gone: 0, refused: tally.pending.length }
		: applyPending(tally.pending, known);

	if (incomplete && tally.pending.length > 0) {
		say('vk', `подмен и пропаж отложено: ${tally.pending.length}. `
			+ `${tailOnly ? 'Читался только хвост темы' : 'Обход был неполным'}, и верить им нельзя.`);
	}

	say('vk', `просмотрено сообщений с файлами: ${comments}`
		+ `${skipped ? ` (после отсечки не считали ${skipped})` : ''}. Новых паков: ${tally.added}.`
		+ `${unreadable ? ` Сообщений, которые ВК не отдал: ${unreadable}.` : ''}`
		+ `${gaps ? ` Кусков темы, которые ВК не отдал: ${gaps}.` : ''}`);
	say('vk', `изменений в прежних: файл заменён у ${applied.replaced}, `
		+ `переписано сообщений ${tally.edited}, убрано файлов ${applied.gone}, вернулось ${tally.back}.`);

	if (broken > 0) {
		throw new Error(`обход не завершён: тем с обрывом — ${broken}`);
	}
}

const LOGO_EXTENSIONS = new Set(['.jpg', '.jpeg', '.jpe', '.jfif', '.png', '.gif', '.webp', '.bmp', '.avif']);

/** Есть ли у обложки уменьшенная копия — та самая, что показывается на карточке. */
const hasThumb = logoFile => Boolean(logoFile) && fs.existsSync(path.join(config.thumbsPath, thumbName(logoFile)));

/** Лежит ли у нас оригинал обложки: из него копию можно сделать когда угодно. */
const hasOriginal = logoFile => Boolean(logoFile) && fs.existsSync(path.join(config.logosPath, logoFile));

/**
 * Скачивает логотип пака из того же архива. Оглавление уже прочитано,
 * так что это ещё два range-запроса.
 *
 * Тут же делается и уменьшенная копия — та, что показывается на карточке.
 * Раньше её делала выкладка (см. scripts/build-web.js), и на домашней машине
 * это было безразлично: оригинал лежит в data/logos и никуда не девается,
 * копию можно посчитать хоть завтра.
 *
 * В облаке — не безразлично, и стоило это четырёх паков без обложек.
 * Оригиналы на полку не ездят (семьдесят мегабайт, см. scripts/state.js) —
 * ездят только готовые копии. Значит, оригинал живёт ровно столько, сколько
 * живёт одноразовый раннер: скачали при разборе, а посчитать копию должны были
 * в самом конце запуска. Не дошло до конца — обход убили по времени, выкладку
 * отключили ключом, шаг упал — и раннер уносит оригинал с собой. В базу же при
 * этом уже записано logo_state='ok', и шаг логотипов такой пак больше не берёт:
 * логотип у него есть, просто показать его нечем. Навсегда.
 *
 * Копия поэтому считается здесь, сразу и в том же запуске. Не вышло уменьшить
 * (уменьшать нечем или картинка не по зубам) — это не ошибка: logo_state
 * остаётся 'ok', оригинал на месте, и копию посчитает выкладка. А вот
 * в облаке, где оригиналу не жить, такой пак попадёт в починку (см. fetchLogos).
 *
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

	await ensureThumb(fileName).catch(() => null);

	return { file: fileName, state: 'ok' };
}

/**
 * Прогоняет список через несколько одновременных работников.
 *
 * Порядок выполнения при этом теряется, и полагаться на него нельзя: строки
 * базы друг от друга не зависят, а вот нумерация в выводе считается не по месту
 * в очереди, а по числу законченных, — иначе номера скакали бы взад-вперёд.
 */
async function runPool(items, jobs, worker, stop = () => false) {
	let next = 0;

	const workers = Array.from({ length: Math.min(jobs, items.length) }, async () => {
		while (next < items.length && !stop()) {
			await worker(items[next++]);
		}
	});

	await Promise.all(workers);
}

/**
 * Полоса работы, у которой работа может прибывать по ходу дела.
 *
 * Шаги теперь идут одновременно, и очередь шага уже нельзя посчитать один раз
 * в начале: разбор берёт паки, которые обход ВК ещё только находит, статистика
 * и модель — те, что разбор ещё только разбирает. Поэтому очередь спрашивается
 * у базы заново, пока есть кому её пополнять: `growing` отвечает, работают ли
 * ещё те шаги, что кормят этот. Как только они закончились и очередь пуста —
 * закончился и этот.
 *
 * `seen` нужен не для порядка, а по существу: статистика перезапрашивает всех
 * разобранных паков, и без памяти о том, кого уже спросили в этот заход, второй
 * запрос к базе вернул бы те же пять тысяч по второму кругу.
 *
 * `group` — необязательный делитель очереди на пачки: с ним работник берёт
 * не строку, а список строк. Нужен шагу «Всё о паке», где несколько паков
 * уезжают к модели одним запросом (см. groupForAnalysis).
 */
async function drain({ step, jobs, take, work, group = null, stop = () => false }) {
	const bar = track(step);
	const seen = new Set();

	// Отпущенное время кончается для всех шагов разом и проверяется здесь одним
	// местом, а не в каждом stop по отдельности: срок дан обходу целиком,
	// и «статистика доработает, а разметка нет» было бы правилом ниоткуда
	const done = () => stop() || outOfTime();

	// Кто может подкинуть работы этому шагу, записано в STEPS одним местом (feeds),
	// чтобы «разбору подносит обход ВК» не приходилось помнить в двух файлах
	const feeds = STEPS.find(item => item.key === step)?.feeds ?? [];
	const growing = () => feeds.some(isRunning);

	let taken = 0;

	while (!done()) {
		const room = limit === Infinity ? Infinity : limit - taken;

		if (room <= 0) {
			return;
		}

		bar.growing = growing();

		const batch = take()
			.filter(row => !seen.has(row.id))
			.slice(0, room === Infinity ? undefined : room);

		if (batch.length === 0) {
			if (!growing()) {
				return;
			}

			// Полоса опустела, но кормящий шаг ещё работает: ждём добавки.
			// Секунда — не темп опроса базы, а верхняя граница простоя: запрос
			// этот местный и стоит миллисекунды.
			await sleep(1000);
			continue;
		}

		for (const row of batch) {
			seen.add(row.id);
		}

		taken += batch.length;
		bar.expand(batch.length);

		// Работу можно раздавать не по строке, а пачками: шаг «Всё о паке»
		// спрашивает у Gemini сразу несколько паков одним запросом, и работник
		// там берёт не пак, а пачку паков (см. group в refreshAnalysis)
		// Без group работник берёт строку, как и раньше; с ним — сразу пачку строк
		const units = group ? group(batch) : batch;

		await runPool(units, jobs, async unit => {
			await work(unit, bar);
			bar.tick(Array.isArray(unit) ? unit.length : 1);
		}, done);
	}
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
	const target = targetSql();

	// Пометка recheck — это перезалитые файлы: пак давно разобран и стоит «ok»,
	// но в сообщении обсуждения лежит уже другой архив (см. syncComment).
	// Разбор идёт с самых свежих (см. NEWEST_FIRST): очередь длинная, ночь конечная,
	// и недоделанным должно остаться позавчерашнее, а не сегодняшнее
	const pending = db.prepare(`
		SELECT p.id, p.url, p.file_name, p.source_key, p.status FROM packages p
		WHERE (p.status IN (${placeholders}) OR p.recheck = 1)${target.where}
		ORDER BY ${NEWEST_FIRST}
	`);

	const params = [...statuses, ...target.params];

	say('parse', `в очереди ${pending.all(...params).length}${queueNote(false)}${jobs > 1 ? `, по ${jobs} разом` : ''}`);

	let ok = 0;
	let failed = 0;
	let dead = 0;
	let logos = 0;

	await drain({
		step: 'parse',
		jobs,
		take: () => pending.all(...params),
		work: async (row, bar) => {
			const label = bar.label();

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

				say('parse', `${label} ${row.file_name ?? row.url} -> «${parsed.name}», вопросов ${parsed.questionCount}, `
					+ `${Math.round(totalSize / 1024 / 1024)} МБ${logo.state === 'ok' ? ', с логотипом' : ''}`);
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
					say('parse', `${label} ${row.file_name ?? row.url} -> не вышло: ${error.message}; оставляю прежний разбор`);
				} else {
					updateFailed.run(status, error.message, Date.now(), row.id);
					say('parse', `${label} ${row.file_name ?? row.url} -> не вышло: ${error.message}`);
				}
			}
		},
	});

	say('parse', `разобрано: ${ok} (логотипов ${logos}), мёртвых ссылок: ${dead}, прочих ошибок: ${failed}.`);
}

/**
 * Догружает логотипы для паков, разобранных до появления этой возможности,
 * и чинит те, у которых логотип по базе есть, а показать его нечем.
 *
 * Второе — про паки вроде 15915–15917 и 16554. В базе у них logo_state='ok',
 * а на деле нет ни уменьшенной копии, ни оригинала: копию должна была посчитать
 * выкладка, но до неё тот запуск не дожил, а оригинал уехал вместе с раннером
 * (см. fetchLogo). Пометки в базе такому случаю нет и быть не может — она
 * не врала в тот миг, когда её ставили, — поэтому чинится он по тому, чего нет
 * на складе: ни копии, ни оригинала. Такой пак качается заново, и на этот раз
 * копия делается сразу.
 */
async function fetchLogos() {
	const target = targetSql();

	// Точечное обновление логотип перекачивает всегда: «докачать недостающие» —
	// это про ночной обход, а названный поимённо пак просят обновить целиком.
	//
	// Паки с logo_state='ok' идут в очередь наравне с прочими: есть у них
	// показывать нечего или нет, по одной базе не видно — это решает уже склад
	// (см. broken ниже)
	const missing = force ? '' : ` AND (p.logo_state IS NULL OR p.logo_state = 'error' OR p.logo_state = 'ok')`;

	const pending = db.prepare(`
		SELECT p.id, p.url, p.file_name, p.source_key, p.name, p.logo_state, p.logo_file FROM packages p
		WHERE p.status = 'ok'${missing}${target.where}
		ORDER BY p.id
	`);

	const params = target.params;

	/**
	 * Что из отобранного и вправду надо качать. Пак, у которого логотип уже есть
	 * и показывается, отсеивается здесь: по одной базе этого не видно — ответ
	 * лежит на складе обложек, а не в ней.
	 *
	 * `--force` отсев отменяет целиком, как и всё прочее: «обнови этот пак»
	 * означает перекачать, а не рассудить, надо ли.
	 */
	const wanted = () => (force
		? pending.all(...params)
		: pending.all(...params)
			.filter(row => row.logo_state !== 'ok' || !(hasThumb(row.logo_file) || hasOriginal(row.logo_file))));

	const queue = wanted();
	const broken = queue.filter(row => row.logo_state === 'ok').length;

	say('logos', `без логотипа ${queue.length - broken}`
		+ `${broken ? `, с потерянной обложкой ${broken}` : ''}`
		+ `${queueNote(false)}${jobs > 1 ? `, по ${jobs} разом` : ''}`);

	let ok = 0;
	let none = 0;
	let failed = 0;

	await drain({
		step: 'logos',
		jobs,
		take: wanted,
		work: async (row, bar) => {
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
				say('logos', `${row.name ?? row.file_name}: ${error.message}`);
			}

			if (bar.milestone(25)) {
				say('logos', bar.line);
			}
		},
	});

	say('logos', `скачано ${ok}, в паке нет ${none}, ошибок ${failed}.`);
}

/**
 * Досчитывает спецвопросы у паков, разобранных до того, как их научились считать.
 *
 * Полный разбор сделал бы то же самое, но заодно переписал бы всё остальное
 * и заново скачал логотипы; здесь из архива читается только content.xml —
 * это пара range-запросов на пак.
 */
async function fetchSpecials() {
	const target = targetSql();
	const missing = force ? '' : ' AND p.special_count IS NULL';

	const pending = db.prepare(`
		SELECT p.id, p.url, p.file_name, p.source_key, p.name FROM packages p
		WHERE p.status = 'ok'${missing}${target.where}
		ORDER BY p.id
	`);

	const params = target.params;

	say('specials', `не посчитаны у ${pending.all(...params).length} паков${queueNote(false)}`
		+ `${jobs > 1 ? `, по ${jobs} разом` : ''}`);

	let ok = 0;
	let failed = 0;
	let found = 0;

	await drain({
		step: 'specials',
		jobs,
		take: () => pending.all(...params),
		work: async (row, bar) => {
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
				say('specials', `${row.name ?? row.file_name}: ${error.message}`);
			}

			if (bar.milestone(25)) {
				say('specials', bar.line);
			}
		},
	});

	say('specials', `посчитаны у ${ok} паков, из них со спецвопросами ${found}, ошибок ${failed}.`);
}

/**
 * Статистика и сложность с сервиса SIGame.
 *
 * Шага этого два, и это не удвоение, а разные вопросы. Полный обход спрашивает
 * заново про все пять тысяч паков: числа игр живут своей жизнью, и обновлять их
 * надо целиком, иначе позавчерашняя сложность так и останется позавчерашней.
 * Стоит он полчаса и пять тысяч запросов к чужому сервису.
 *
 * Второй спрашивает только про тех, у кого статистики нет вовсе, — про паки,
 * добавленные этой ночью. Это десятки запросов вместо тысяч, и после разбора
 * новых паков нужен обычно именно он: у остальных числа и так вчерашние.
 *
 * @param {'all'|'new'} scope
 */
async function refreshStats(scope = 'all') {
	const step = scope === 'new' ? 'statsnew' : 'stats';

	// «Только новые» — это те, кого ни разу не спрашивали. Пак, про который сервис
	// ответил «не знаю» (found = 0), новым уже не считается: строка у него есть,
	// и переспрашивать его каждую ночь означало бы вечную очередь из тех, кого
	// статистика не знает и знать не будет.
	const fresh = scope === 'new'
		? 'AND NOT EXISTS (SELECT 1 FROM stats s WHERE s.package_id = p.id)'
		: '';

	const target = targetSql();

	const pending = db.prepare(`
		SELECT p.id, p.name, p.authors
		FROM packages p
		WHERE p.status = 'ok' AND p.name IS NOT NULL ${fresh}${target.where}
		ORDER BY p.id
	`);

	const params = target.params;
	const statsJobs = Math.max(1, config.statsJobs);

	say(step, `запрашиваю ${pending.all(...params).length} паков${scope === 'new' ? ' без статистики' : ''}`
		+ `${queueNote(false)}, по ${statsJobs} разом`);

	let found = 0;
	let rated = 0;

	await drain({
		step,
		jobs: statsJobs,
		take: () => pending.all(...params),
		work: async (row, bar) => {
			const authors = JSON.parse(row.authors);

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
				say(step, `${row.name}: ${error.message}`);
			}

			if (bar.milestone(100)) {
				say(step, bar.line);
			}

			await sleep(config.statsDelayMs);
		},
	});

	say(step, `статистика найдена у ${found} паков, оценку сложности получили ${rated}.`);
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
 * описания не хватит. Обе полосы смотрят на этот признак и сворачиваются,
 * вместо того чтобы выяснять то же самое заново на каждом оставшемся паке.
 */
let geminiQuotaSpent = false;

/**
 * Кончились суточные запросы: перейти на запасную модель или свернуть полосу.
 *
 * Зовётся оттуда, где раньше стояло просто «geminiQuotaSpent = true». Разница
 * в одном: сперва спрашивается, есть ли чем продолжать (см. nextSpareModel
 * в models.js), и только если нечем — ночь на этом кончается.
 *
 * @param {string} step от чьего имени писать в лог
 * @param {string} model модель, которой этот запрос отказали
 * @returns {boolean} перешли ли на другую: false — полоса сворачивается
 */
function switchModel(step, model) {
	if (!fallback) {
		return false;
	}

	// Полос две и работников в каждой несколько: отказ по одному и тому же лимиту
	// прилетает разом с нескольких сторон. Переключает первый, кто добежал,
	// а остальные видят, что модель уже не та, которой им отказали, — и молчат.
	// Иначе один кончившийся лимит перебрал бы весь список запасных подряд
	if (model !== activeModel()) {
		return true;
	}

	const next = nextSpareModel(model);

	if (!next) {
		return false;
	}

	useModel(next);
	say(step, `у ${model} суточные запросы кончились — перехожу на ${next}. ${usageLine(next)}`);

	return true;
}

/**
 * Что делать с ошибкой модели, прилетевшей в полосу.
 *
 * Обычная ошибка (сеть, оборванный ответ) полосу не трогает: следующий пак
 * вполне может разобраться. Ошибка, после которой следующий получит то же самое,
 * сворачивает полосу — кроме одного случая: кончившиеся суточные запросы можно
 * пережить, перейдя на запасную модель.
 *
 * @param {string} step от чьего имени писать в лог
 * @param {Error} error что пришло
 * @param {string} model модель, которой отказали
 */
function noteGeminiFailure(step, error, model) {
	if (!isFatalGeminiError(error)) {
		return;
	}

	// Кончились сутки у этой модели, а не у ключа: если есть чем продолжать,
	// полоса не сворачивается вовсе — просто дальше спрашивается другая
	if (error.quota === true && switchModel(step, model)) {
		return;
	}

	geminiQuotaSpent = geminiQuotaSpent || error.quota === true;
	say(step, stopReason(error));
}

/** Что написать, сворачивая полосу. Кончившиеся лимиты — не поломка. */
function stopReason(error) {
	return error.quota === true
		? `у ${activeModel()} кончились суточные лимиты. Оставшиеся паки разберутся при следующем запуске: `
			+ 'шаг и так берёт только те, у которых разметки нет.'
		: 'останавливаю шаг: следующий пак получит ту же ошибку.';
}

/** Общая проверка перед шагом с моделью. Возвращает false, если спрашивать некого. */
function geminiReady(step) {
	if (!hasGemini()) {
		say(step, 'пропускаю, нет ключа Gemini (data/gemini-key.txt или GEMINI_API_KEY)');
		return false;
	}

	if (geminiQuotaSpent) {
		say(step, 'пропускаю, лимиты Gemini кончились');
		return false;
	}

	const left = usage(activeModel());

	if (left.unavailable) {
		say(step, `пропускаю: модель ${activeModel()} закрыта для этого ключа (${left.refusal ?? 'без объяснений'})`);
		return false;
	}

	// Лимиты кончились ещё до начала шага — обычное дело для второго прохода ночи:
	// первый уже выбрал сутки. Переход на запасную модель годится и здесь
	if (left.spentOut) {
		if (switchModel(step, activeModel())) {
			return true;
		}

		say(step, `пропускаю: у ${activeModel()} лимиты на сегодня уже кончились (${usageLine(activeModel())})`);
		geminiQuotaSpent = true;
		return false;
	}

	return true;
}

/**
 * Считает по разметке тем всё, что хранится у пака, записывает это и рассказывает
 * в лог, что получилось.
 *
 * Отдельной работой, потому что разметка приходит двумя путями: своим шагом
 * (refreshTopics) и вместе с описанием одним запросом на всё (refreshAnalysis).
 * Считаться и записываться она обязана одинаково — что бы её ни принесло.
 *
 * @param {string} step от чьего имени писать в лог
 * @param {{labelled: number, mixed: number, repeats: number}} tally общий счёт шага
 */
function saveTopics(step, label, row, themes, marks, model, tally) {
	const { shares, questions } = computeShares(themes, marks);
	// Виды «прочего» считаются раньше ярлыка, потому что ярлык на них смотрит:
	// пак, у которого «прочее» почти всё и оно спортивное, — не солянка,
	// а спортпак (см. KIND_PACKS и toPrimary в topics.js)
	const kinds = computeOtherKinds(themes, marks);
	const { topic, share } = toPrimary(shares, questions, kinds);
	// Франшизы и области лежат одним списком, но означают разное: по франшизам
	// считаются повторы, по областям пак целиком про футбол получает подпись
	// (см. computeAreas в topics.js). Кто из них главный — решает доля: ярлык
	// пака про Вторую мировую берётся оттуда же, откуда ярлык пака про «Наруто»
	const repeats = computeFranchises(themes, marks);
	const franchises = [...repeats, ...computeAreas(themes, marks)]
		.sort((a, b) => b.share - a.share || b.themes - a.themes);
	const top = franchises[0] ?? null;
	// Жанры считаются от типа пака, поэтому строкой ниже toPrimary:
	// у солянки жанр называть не от чего, и список выйдет пустым
	const genres = computeGenres(themes, marks, topic);
	// Из чего пак сделан по носителю: манга или манхва, кино или сериалы.
	// Спрашивается у двух тематик, и обе — те, у которых ярлык до сих пор
	// молчал о главном (см. FORMS в settings.js)
	const { forms, coverage: formCoverage } = computeForms(themes, marks, topic);
	// Когда вышло названное в паке и откуда оно родом. Считается у всех паков
	// и хранится тоже у всех: показывать это или нет, решает сайт по типу пака
	// (десятилетия у «прочего» смысла не имеют, происхождение — у аниме),
	// а пересчёт порогов и ярлыков модель переспрашивать не должен
	const { decades, coverage: decadeCoverage } = computeDecades(themes, marks);
	const { origins, coverage: originCoverage } = computeOrigin(themes, marks);

	updateTopics.run(
		JSON.stringify(shares ?? {}),
		topic,
		share,
		JSON.stringify(franchises),
		top?.name ?? null,
		top?.share ?? null,
		// Доля повторов хранится готовой: по ней отбирает галочка «мало повторов»,
		// и считать её на лету из этого же JSON выходит впятеро дороже самой
		// выдачи (см. repeatShare в keys.js)
		repeatShare(franchises, config.subjectPackShare),
		JSON.stringify(kinds),
		JSON.stringify(genres),
		genres.length > 0 ? topic : null,
		JSON.stringify(forms),
		forms.length > 0 ? topic : null,
		formCoverage,
		JSON.stringify(decades),
		decadeCoverage,
		JSON.stringify(origins),
		originCoverage,
		Date.now(),
		model,
		row.id,
	);

	if (topic && topic !== 'mixed') {
		tally.labelled++;
	} else if (topic === 'mixed') {
		tally.mixed++;
	}

	if (repeats.length > 0) {
		tally.repeats++;
	}

	const percents = Object.entries(shares ?? {})
		.filter(([key, v]) => key !== 'other' && v > 0)
		.sort((a, b) => b[1] - a[1])
		.map(([key, v]) => `${key} ${Math.round(v * 100)}%`)
		.join(', ');

	// Повторы — вторая строка: в одну с процентами они не влезают. Области
	// в неё не идут: повтором они не считаются, и место им в строке ниже
	const repeated = repeats
		.map(f => `${f.name} ×${f.themes}`)
		.join(', ');

	const areas = franchises
		.filter(f => f.kind === 'area')
		.map(f => `${f.name} ${Math.round(f.share * 100)}%`)
		.join(', ');

	say(step, `${label} «${row.name}»: ${percents || 'ничего тематического'} -> ${topic ?? 'мало вопросов'}`);

	if (repeated) {
		say(step, `      повторы: ${repeated}`);
	}

	if (areas) {
		say(step, `      предмет: ${areas}`);
	}

	// Чем оказалось «прочее»: без этой строки в логе видно только
	// «прочего 40%», а сорок процентов чего — непонятно
	if (kinds.length > 0) {
		say(step, `      прочее: ${kinds.map(kind => `${OTHER_KINDS[kind.key]} ${Math.round(kind.share * 100)}%`).join(', ')}`);
	}

	// Чем этот музпак отличается от соседнего: рэп внутри или опенинги
	if (genres.length > 0) {
		const names = GENRES[topic].list;
		say(step, `      ${GENRES[topic].question.toLowerCase()} `
			+ genres.map(genre => `${names[genre.key]} ${Math.round(genre.share * 100)}%`).join(', '));
	}

	// Из чего пак сделан по носителю. Покрытие рядом по той же причине, что
	// у годов: «манхва 100%» по одной теме из тридцати — это не про пак
	if (forms.length > 0) {
		const names = FORMS[topic].list;
		say(step, `      ${FORMS[topic].question.toLowerCase()} `
			+ forms.map(form => `${names[form.key]} ${Math.round(form.share * 100)}%`).join(', ')
			+ ` (по ${Math.round(formCoverage * 100)}% тематики)`);
	}

	// Каких лет пак и чьё в нём содержимое. Покрытие пишется рядом нарочно:
	// «нулевые 60%» по четверти пака и по всему паку — это разные утверждения,
	// и в логе они обязаны различаться
	if (decades.length > 0) {
		say(step, `      годы: ${decades.map(d => `${decadeName(d.key)} ${Math.round(d.share * 100)}%`).join(', ')}`
			+ ` (по ${Math.round(decadeCoverage * 100)}% пака)`);
	}

	if (origins.length > 0) {
		say(step, `      откуда: ${origins.map(o => `${ORIGINS[o.key]} ${Math.round(o.share * 100)}%`).join(', ')}`
			+ ` (по ${Math.round(originCoverage * 100)}% пака)`);
	}
}

/** Раскладывает темы паков по тематикам и считает доли. */
async function refreshTopics() {
	if (!geminiReady('topics')) {
		return;
	}

	// Разметка старее нынешних правил считается отсутствующей: доли в ней означают
	// не то же самое, что теперь (см. TOPICS_VERSION).
	const weaker = weakerModelSql('topics_model');
	const condition = retopics
		? ''
		: `AND (p.topics_at IS NULL OR p.topics_version < ${TOPICS_VERSION}${weaker.where})`;
	const target = targetSql();
	const priority = priorityOrderSql('topics');
	const pending = db.prepare(`
		SELECT p.id, p.name, p.rounds FROM packages p
		WHERE p.status = 'ok' AND p.rounds <> '[]' ${condition}${target.where}
		ORDER BY ${priority.order}
	`);

	const params = [...(retopics ? [] : weaker.params), ...target.params, ...priority.params];
	const queue = pending.all(...params);

	say('topics', `через ${activeModel()}${queueNote()}: паков без разметки ${queue.length}`
		+ `${upgrade ? ' (считая размеченные моделью послабее)' : ''}. ${usageLine(activeModel())}`);

	// Паки, разобранные старой версией, хранят только названия тем — по ним модель угадывает плохо
	const withoutSamples = queue.filter(row => !normalizeRounds(row.rounds).some(r => r.themes.some(t => t.sample))).length;

	if (withoutSamples > queue.length / 5) {
		say('topics', `у ${withoutSamples} паков нет образцов ответов: сначала стоит выполнить node src/indexer.js --parse-only --reparse`);
	}

	const tally = { labelled: 0, mixed: 0, repeats: 0 };

	await drain({
		step: 'topics',
		jobs: Math.max(1, config.geminiJobs),
		stop: () => geminiQuotaSpent,
		take: () => pending.all(...params),
		work: async (row, bar) => {
			const themes = listThemes(row.id, normalizeRounds(row.rounds));
			const label = bar.label();

			if (themes.length === 0) {
				return;
			}

			const model = activeModel();

			try {
				const marks = await classifyThemes(themes);
				saveTopics('topics', label, row, themes, marks, model, tally);
			} catch (error) {
				say('topics', `${label} «${row.name}»: ${error.message}`);

				// Ключ, модель или кончившиеся лимиты — дальше будет то же самое.
				// Кроме одного случая: кончившиеся сутки переживаются переходом
				// на запасную модель (см. noteGeminiFailure)
				noteGeminiFailure('topics', error, model);
			}
		},
	});

	say('topics', `ярлык получили ${tally.labelled} паков, солянок ${tally.mixed}, `
		+ `с повторами франшиз ${tally.repeats}. ${usageLine(activeModel())}`);
}

/**
 * Просит модель описать каждый пак одной строкой: о чём он вообще.
 *
 * Описание составляется всем разобранным пакам без исключения — в том числе тем,
 * под которыми в обсуждении уже написано целое сочинение. Это разные вещи и стоят
 * они на карточке порознь: авторский текст — слова выложившего, как он их написал,
 * а эта строка — то, что в паке на самом деле, по ответам его вопросов. Первое
 * бывает и на десять абзацев, и «всем привет, вот пак», и рассказывает скорее
 * о поводе, чем о содержимом.
 */
async function refreshSummaries() {
	if (!geminiReady('summary')) {
		return;
	}

	const weaker = weakerModelSql('summary_model');
	// Паку, описанному до появления оценки аудитории или вопроса про язык, вопрос
	// задаётся заново: спрашиваются они тем же запросом, что и описание,
	// и переспросить его — единственный способ их получить (см. audience_at
	// и language_ai в db.js)
	const condition = resummary
		? ''
		: `AND (p.summary_at IS NULL OR p.audience_at IS NULL OR p.language_ai IS NULL${weaker.where})`;
	const target = targetSql();
	const priority = priorityOrderSql('summary');
	const pending = db.prepare(`
		SELECT p.id, p.name, p.tags, p.rounds, p.comment_text, p.language FROM packages p
		WHERE p.status = 'ok' ${condition}${target.where}
		ORDER BY ${priority.order}
	`);

	const params = [...(resummary ? [] : weaker.params), ...target.params, ...priority.params];

	say('summary', `через ${activeModel()}${queueNote()}: паков без описания ${pending.all(...params).length}`
		+ `${upgrade ? ' (считая описанные моделью послабее)' : ''}. ${usageLine(activeModel())}`);

	let described = 0;
	let silent = 0;

	await drain({
		step: 'summary',
		jobs: Math.max(1, config.geminiJobs),
		stop: () => geminiQuotaSpent,
		take: () => pending.all(...params),
		work: async (row, bar) => {
			const themes = listThemes(row.id, normalizeRounds(row.rounds));
			const label = bar.label();

			const model = activeModel();

			try {
				const { summary, audience, language } = await describePack({
					name: row.name ?? '',
					tags: jsonOrDefault(row.tags, []),
					about: row.comment_text ?? '',
					themes,
				});

				saveSummary(row, model, summary, audience, language);

				if (summary) {
					described++;
				} else {
					silent++;
				}

				say('summary', `${label} «${row.name}»: ${summary || 'сказать нечего'}`);
				say('summary', `      ${audienceLine(audience)}`);
				say('summary', `      ${languageLine(language, row.language)}`);
			} catch (error) {
				say('summary', `${label} «${row.name}»: ${error.message}`);

				noteGeminiFailure('summary', error, model);
			}
		},
	});

	say('summary', `описание получили ${described} паков${silent ? `, сказать нечего про ${silent}` : ''}. ${usageLine(activeModel())}`);
}

/**
 * Сколько вопросов в теме, у которой это число не записано.
 *
 * Такие темы остались от старого разбора (в базе у них questions = 0), а размер
 * пачки без них считался бы неверно: пак из тридцати «пустых» тем выглядел бы
 * невесомым и уезжал бы к модели вместе с десятком таких же. Пять с небольшим —
 * среднее по всей базе (480 тысяч вопросов на 88 тысяч тем).
 */
const QUESTIONS_PER_THEME = 5;

/**
 * Чем пак тяжёл для модели: сколько в нём тем и сколько вопросов.
 * Считается по сохранённым раундам, не разбирая их в темы целиком, — нужно это
 * только затем, чтобы набрать пачку по размеру (см. groupForAnalysis).
 */
function packWeight(row) {
	let themes = 0;
	let questions = 0;

	for (const round of normalizeRounds(row.rounds)) {
		for (const theme of round.themes) {
			themes++;
			questions += theme.questions > 0 ? theme.questions : QUESTIONS_PER_THEME;
		}
	}

	return { themes, questions };
}

/**
 * Делит очередь на пачки, которые уедут к модели одним запросом.
 *
 * Главное число здесь — вопросы (analyzeQuestionBatch): цена запроса это цена
 * содержимого, а содержимое темы тем длиннее, чем больше в ней вопросов. Паками
 * мерить нельзя вовсе — пак бывает и на тридцать вопросов, и на тысячу двести,
 * и «пять паков» означало то восемь тысяч токенов, то шестьдесят.
 *
 * Рядом стоят два предохранителя: сколько паков (analyzePackBatch — тысяча
 * вопросов может набраться и двумя десятками крошечных) и сколько тем
 * (analyzeThemeBatch — в ответе по объекту на тему, и его длину считают темы).
 * Что кончится раньше, то и закрывает пачку.
 *
 * Пак, который один перебирает любой из пределов, едет один: разрезать пак между
 * запросами нельзя — описание и аудиторию модель называет по всему списку сразу.
 */
function groupForAnalysis(rows) {
	const maxPacks = Math.max(1, config.analyzePackBatch);
	const maxThemes = Math.max(1, config.analyzeThemeBatch);
	const maxQuestions = Math.max(1, config.analyzeQuestionBatch);
	const groups = [];
	let current = [];
	let themes = 0;
	let questions = 0;

	for (const row of rows) {
		const weight = packWeight(row);
		const full = current.length >= maxPacks
			|| themes + weight.themes > maxThemes
			|| questions + weight.questions > maxQuestions;

		if (current.length > 0 && full) {
			groups.push(current);
			current = [];
			themes = 0;
			questions = 0;
		}

		current.push(row);
		themes += weight.themes;
		questions += weight.questions;
	}

	if (current.length > 0) {
		groups.push(current);
	}

	return groups;
}

/**
 * Проценты категорий и краткое описание — одним запросом на несколько паков.
 *
 * Этим шагом заменяются оба предыдущих, когда выбраны они вместе (см. selectedSteps).
 * Смысл замены — суточный лимит: он считает запросы, а не темы, и пак, стоивший
 * два запроса, стоит теперь один. Список тем при этом уезжает наверх один раз
 * вместо двух — то есть за ту же ночь бесплатный ключ проходит вдвое больше паков.
 *
 * Дальше та же мысль доведена до конца: раз считаются запросы, в одном запросе
 * едет сразу несколько паков (см. analyzePackBatch в config.js и analyzePacks
 * в gemini.js). Пятеро в запросе — это и впятеро больше паков за сутки,
 * и впятеро быстрее по минутам: минутный предел тоже считает запросы, и очередь
 * (см. takeTurn) расставляет их по четыре секунды друг от друга, сколько
 * работников ни поставь.
 *
 * Очередь общая: сюда берётся пак, которому не хватает хоть чего-то одного —
 * хоть разметки, хоть описания, — и получает он сразу оба. Спрашивать про
 * описание отдельно, когда список тем всё равно уже отправлен, было бы странно.
 */
async function refreshAnalysis() {
	if (!geminiReady('analyze')) {
		return;
	}

	const weakTopics = weakerModelSql('topics_model');
	const weakSummary = weakerModelSql('summary_model');
	const needTopics = retopics
		? '1'
		: `(p.topics_at IS NULL OR p.topics_version < ${TOPICS_VERSION}${weakTopics.where})`;
	// language_ai IS NULL — «про язык не спрашивали ни разу». Отдельным условием,
	// потому что паки, описанные до появления вопроса про язык, иначе не встали бы
	// в очередь никогда: summary_at и audience_at у них давно проставлены
	const needSummary = resummary
		? '1'
		: `(p.summary_at IS NULL OR p.audience_at IS NULL OR p.language_ai IS NULL${weakSummary.where})`;
	const target = targetSql();
	const priority = priorityOrderSql('analyze');

	// comment_text — это то, что автор написал под паком в обсуждении: единственное
	// место, где сказано, что он задумывал. Модели оно уходит подсказкой, а не
	// истиной: в описании бывает «чистое аниме» у пака, где треть тем про игры
	// (см. PACK_CONTEXT в gemini.js)
	const pending = db.prepare(`
		SELECT p.id, p.name, p.tags, p.rounds, p.comment_text, p.language FROM packages p
		WHERE p.status = 'ok' AND (${needTopics} OR ${needSummary})${target.where}
		ORDER BY ${priority.order}
	`);

	const params = [
		...(retopics ? [] : weakTopics.params),
		...(resummary ? [] : weakSummary.params),
		...target.params,
		...priority.params,
	];

	say('analyze', `через ${activeModel()}${queueNote()}: паков без разметки или описания ${pending.all(...params).length}`
		+ `${upgrade ? ' (считая размеченные моделью послабее)' : ''}. `
		+ `Спрашиваю одним запросом про ${config.analyzeQuestionBatch} вопросов сразу `
		+ `(это сколько паков придётся — от одного до ${config.analyzePackBatch}). `
		+ usageLine(activeModel()));

	const tally = { labelled: 0, mixed: 0, repeats: 0 };
	let described = 0;
	let silent = 0;
	let split = 0;

	await drain({
		step: 'analyze',
		jobs: Math.max(1, config.geminiJobs),
		stop: () => geminiQuotaSpent,
		take: () => pending.all(...params),
		group: groupForAnalysis,
		work: async (rows, bar) => {
			const packs = rows.map(row => ({
				row,
				themes: listThemes(row.id, normalizeRounds(row.rounds)),
				label: bar.label(),
			}));

			const model = activeModel();

			try {
				const answers = await analyzePacks(packs.map(pack => ({
					name: pack.row.name ?? '',
					tags: jsonOrDefault(pack.row.tags, []),
					about: pack.row.comment_text ?? '',
					themes: pack.themes,
				})));

				packs.forEach(({ row, themes, label }, index) => {
					const answer = answers[index];

					// Пак без разобранных тем описание всё равно получает — по названию
					// и тегам, — а вот доли считать не из чего
					if (themes.length > 0) {
						saveTopics('analyze', label, row, themes, answer.marks, model, tally);
					}

					saveSummary(row, model, answer.summary, answer.audience, answer.language);

					if (answer.summary) {
						described++;
					} else {
						silent++;
					}

					say('analyze', `${themes.length > 0 ? '     ' : `${label} «${row.name}»:`} `
						+ `описание: ${answer.summary || 'сказать нечего'}`);

					// Кому этот пак: возраст и пол — оценка модели по содержимому,
					// а не статистика игроков (см. AUDIENCE_RULES в gemini.js)
					say('analyze', `      ${audienceLine(answer.audience)}`);

					// Какой язык модель насчитала этому паку. Стоит рядом
					// с аудиторией и по той же причине: и то, и другое — её
					// суждение, а не запись из файла (см. languageLine)
					say('analyze', `      ${languageLine(answer.language, row.language)}`);

					// Что модель искала в поиске. Строка нужна не для красоты: по ней
					// видно, гуглит ли она то, о чём пак, — или само шуточное название
					// темы, из которого не следует ничего (см. SOURCES в gemini.js)
					if (answer.queries?.length > 0) {
						say('analyze', `      искала: ${answer.queries.slice(0, 6).join(' | ')}`);
					}

					// Одним запросом не вышло — пак разобран по-старому, двумя.
					// Считаем такие: если их много, стоит уменьшить паки, а не гадать
					if (answer.split) {
						split++;
						say('analyze', `      одним запросом не вышло (${answer.reason}), спросил двумя`);
					}
				});
			} catch (error) {
				// Ошибка тут одна на всю пачку: паки в ней разбираются одним
				// запросом, и отказ означает, что не разобран ни один
				say('analyze', `${packs.map(pack => `${pack.label} «${pack.row.name}»`).join(', ')}: ${error.message}`);

				noteGeminiFailure('analyze', error, model);
			}
		},
	});

	say('analyze', `ярлык получили ${tally.labelled} паков, солянок ${tally.mixed}, `
		+ `с повторами франшиз ${tally.repeats}; описание получили ${described}`
		+ `${silent ? `, сказать нечего про ${silent}` : ''}`
		+ `${split ? `. Двумя запросами пришлось спросить про ${split}` : ''}. `
		+ `${usageLine(activeModel())}; ${tokensLine()}`);
}

/** Пересчитывает уровни по уже сохранённым числам — нужен после правки порогов в настройках. */
function recalcLevels() {
	// Названные поимённо паки пересчитываются одни: точечное обновление не должно
	// трогать соседей — даже пересчётом, который ничего не портит
	const target = targetSql();
	const only = target.where
		? ` AND package_id IN (SELECT p.id FROM packages p WHERE 1 = 1${target.where})`
		: '';

	const rows = db.prepare(`SELECT package_id, started_games, completed_games, shown, answered, correct, wrong,
		right_percent, take_percent FROM stats WHERE found = 1${only}`).all(...target.params);
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

	say('recalc', `уровни: обработано ${rows.length}, оценку получили ${changed}`);
}

/** Пересчитывает ярлыки паков по сохранённым долям — нужен после правки порога. */
function recalcTopics() {
	const target = targetSql();
	const rows = db.prepare(`SELECT p.id, p.topic_shares, p.question_count, p.franchises, p.genre_topic,
			p.form_topic, p.other_kinds
		FROM packages p WHERE p.topics_at IS NOT NULL${target.where}`).all(...target.params);
	const update = db.prepare('UPDATE packages SET primary_topic = ?, primary_share = ?, franchise_top = ?, franchise_top_share = ? WHERE id = ?');

	// Жанры пересчитать без модели нельзя вовсе: они считаются по разметке тем,
	// а в базе от неё остались одни доли. Поэтому у пака, сменившего тип, жанры
	// убираются, а сам пак встаёт обратно в очередь к модели (topics_version = 0):
	// жанры музыки под подписью «какой жанр аниме» — не полбеды, а прямое враньё.
	// Доли и ярлык при этом остаются на месте, и до переспроса пак выглядит как
	// прежде, только без жанров.
	const dropGenres = db.prepare(`UPDATE packages SET genres = '[]', genre_topic = NULL, topics_version = 0 WHERE id = ?`);

	// То же самое и с носителями, и по той же причине: «Сериалы 60%» в верхней
	// полоске пака, переставшего быть кинопаком, читались бы как доля манги
	const dropForms = db.prepare(`UPDATE packages SET forms = '[]', form_topic = NULL, form_coverage = NULL, topics_version = 0 WHERE id = ?`);

	// Область, повторяющая ярлык пака, из сохранённого вычищается прямо здесь,
	// не дожидаясь модели.
	//
	// Дождаться её тут нельзя по времени: суточного лимита хватает на сотни
	// паков при базе в тысячи, и «Cinema», «Movies», «Games» и «Erudition»
	// простояли бы в списке «Пак целиком про одно» ещё месяцы — четырьмя
	// строками по полсотни паков в каждой, ничего не говорящими о паках.
	// А сказать про них нечего и по существу: «пак целиком про кино» — это
	// в точности кинопак, ярлык которого стоит рядом (см. NOT_AREAS
	// в franchise.js). Английские названия оттуда же и той же природы.
	//
	// Переспрашивать модель ради этого не надо: убирается лишняя строка,
	// а не считается новая, — и убрать её можно по тому, что уже записано.
	// Доля повторов пересчитывается вместе со списком: она из него и считается,
	// и разойдись они — галочка «мало повторов» отбирала бы по вчерашнему списку
	const rewriteFranchises = db.prepare('UPDATE packages SET franchises = ?, repeat_share = ? WHERE id = ?');

	let labelled = 0;
	let dropped = 0;
	let cleaned = 0;

	for (const row of rows) {
		const shares = jsonOrDefault(row.topic_shares, null);
		// Виды «прочего» уже посчитаны и лежат в базе: по ним пак, который весь
		// про спорт, получает свой ярлык, не дожидаясь модели
		const { topic, share } = toPrimary(shares, row.question_count ?? 0, jsonOrDefault(row.other_kinds, []));

		const stored = jsonOrDefault(row.franchises, []);
		// Проверяется по названию, а не по виду записи. Вид («область» или
		// «произведение») появился не сразу, и у записей постарше его нет вовсе;
		// а главное — модель кладёт «Games» и «Movies» в оба поля одинаково,
		// и произведением такое не становится (см. isCategoryName в franchise.js)
		const kept = stored.filter(f => !isCategoryName(f.name));

		if (kept.length !== stored.length) {
			rewriteFranchises.run(JSON.stringify(kept), repeatShare(kept, config.subjectPackShare), row.id);
			cleaned++;
		}

		// Сами франшизы пересчитать без модели нельзя — она называет их по темам, —
		// но какая из сохранённых главная, видно и так
		const top = kept
			.filter(f => f.themes >= config.franchiseMinThemes)
			.sort((a, b) => b.questions - a.questions)[0] ?? null;

		update.run(topic, share, top?.name ?? null, top?.share ?? null, row.id);

		if (topic && topic !== 'mixed') {
			labelled++;
		}

		if (row.genre_topic && row.genre_topic !== topic) {
			dropGenres.run(row.id);
			dropped++;
		}

		if (row.form_topic && row.form_topic !== topic) {
			dropForms.run(row.id);
		}
	}

	say('recalc', `тематики: обработано ${rows.length}, ярлык получили ${labelled}`
		+ `${dropped > 0 ? `, у ${dropped} сменился тип — жанры переспросим` : ''}`
		+ `${cleaned > 0 ? `, у ${cleaned} убрана область, повторявшая ярлык` : ''}`);
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
	const waiting = db.prepare(`SELECT COUNT(*) AS c FROM packages WHERE status = 'new'`).get().c;
	const withStats = db.prepare('SELECT COUNT(*) AS c FROM stats WHERE found = 1').get().c;
	const withLogo = db.prepare(`SELECT COUNT(*) AS c FROM packages WHERE logo_state = 'ok'`).get().c;
	const described = db.prepare(`SELECT COUNT(*) AS c FROM packages WHERE summary IS NOT NULL AND summary <> ''`).get().c;
	// Главный предмет — франшиза или область, что из них крупнее (см. saveTopics)
	const withSubject = db.prepare(`SELECT COUNT(*) AS c FROM packages WHERE franchise_top IS NOT NULL`).get().c;
	// Спецвопросы считаются при разборе: у паков, разобранных раньше, их число неизвестно
	const specials = db.prepare(`SELECT COUNT(*) AS c FROM packages WHERE status = 'ok' AND special_count IS NULL`).get().c;
	const levels = db.prepare('SELECT level, COUNT(*) AS c FROM stats WHERE level IS NOT NULL GROUP BY level ORDER BY level DESC').all();
	const topics = db.prepare('SELECT primary_topic, COUNT(*) AS c FROM packages WHERE primary_topic IS NOT NULL GROUP BY primary_topic ORDER BY c DESC').all();
	const byModel = db.prepare(`
		SELECT COALESCE(topics_model, 'до появления пометки') AS model, COUNT(*) AS c
		FROM packages WHERE topics_at IS NOT NULL GROUP BY model ORDER BY c DESC
	`).all();

	console.log('');
	console.log('=== Итого');
	console.log(`Паков в базе: ${total} (разобрано ${parsed}, мёртвых ссылок ${deadLinks}, с ошибками ${errors}`
		+ `${gone > 0 ? `, убрано из обсуждения ${gone}` : ''}${waiting > 0 ? `, ждут разбора ${waiting}` : ''})`);
	console.log(`Есть статистика: ${withStats}. С логотипом: ${withLogo}. С описанием: ${described}. С предметом: ${withSubject}.`);

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

	if (byModel.length > 0) {
		console.log('Чем размечено:');

		for (const row of byModel) {
			console.log(`  ${row.model}: ${row.c}`);
		}
	}

	if (hasGemini()) {
		console.log(`Расход Gemini: ${usageLine(activeModel())} (${activeModel()})`);
	}
}

// ————— служебные ключи, после которых ничего не делается —————

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

if (has('--gemini-usage')) {
	const state = usageReport();
	console.log(`Расход за сутки ${state.day} (по тихоокеанскому времени: там сбрасываются квоты Google)`);

	for (const model of state.models) {
		const limit = model.limit === null ? 'предел неизвестен' : `${model.spent} из ${model.exact ? '' : '≈'}${model.limit}`;
		const state_ = model.unavailable ? ' — закрыта для этого ключа' : model.spentOut ? ' — лимит кончился' : '';
		console.log(`  ${model.current ? '*' : ' '} ${model.id.padEnd(26)} ${limit}${state_}`);
	}

	console.log('Звёздочкой отмечена выбранная модель. Точные пределы (без «≈») — те, что Gemini назвал сам, отказав.');
	process.exit(0);
}

/**
 * Шаги и то, кто кому подносит работу.
 *
 * `feeds` — не «выполнять после», а «пока он работает, у меня может прибавиться»:
 * обход ВК находит паки для разбора, разбор готовит их для статистики и модели.
 * Полосы при этом стартуют все разом (см. drain).
 *
 * `after` — настоящее ожидание, и оно ровно одно: пересчёт уровней и ярлыков
 * считает по тому, что уже лежит в базе, и начинать его раньше, чем статистика
 * с тематиками закончат складывать туда числа, попросту бессмысленно.
 */
const STEPS = [
	{ key: 'vk', name: 'Обход обсуждений ВК', flag: '--vk-only', run: scanVk, byDefault: true },
	{ key: 'parse', name: 'Разбор паков', flag: '--parse-only', run: parsePackages, byDefault: true, feeds: ['vk'] },
	{ key: 'stats', name: 'Статистика и сложность', flag: '--stats-only', run: () => refreshStats('all'), byDefault: true, feeds: ['parse'] },
	// Тот же шаг, но только для паков, у которых статистики нет вовсе. Отдельным
	// шагом, а не галочкой: его и полный обход выбирают в разных случаях, и по
	// умолчанию не идёт ни один из двух, раз уж полный уже отмечен
	{ key: 'statsnew', name: 'Статистика только у новых', flag: '--stats-new', run: () => refreshStats('new'), byDefault: false, feeds: ['parse'] },
	{ key: 'topics', name: 'Тематики и проценты', flag: '--topics-only', run: refreshTopics, byDefault: true, feeds: ['parse'] },
	{ key: 'summary', name: 'Краткие описания', flag: '--summary-only', run: refreshSummaries, byDefault: true, feeds: ['parse'] },
	// Оба предыдущих шага сразу, одним запросом к модели на пак. Своего ключа
	// у него нет нарочно: выбирают не его, а те два, — а он получается сам,
	// когда выбраны оба (см. selectedSteps)
	{ key: 'analyze', name: 'Проценты и описания', flag: '--analyze', run: refreshAnalysis, byDefault: false, feeds: ['parse'] },
	{ key: 'logos', name: 'Логотипы', flag: '--logos', run: fetchLogos, byDefault: false, feeds: ['parse'] },
	{ key: 'specials', name: 'Спецвопросы', flag: '--specials', run: fetchSpecials, byDefault: false, feeds: ['parse'] },
	{ key: 'recalc', name: 'Пересчёт уровней и ярлыков', flag: '--recalc', run: recalcAll, byDefault: false, after: ['stats', 'statsnew', 'topics', 'analyze'] },
];

/** Какие шаги делать: по флагам, по списку --steps= или, если не сказано, обычный полный проход. */
function selectedSteps() {
	const asked = new Set(text('steps').split(',').map(s => s.trim()).filter(Boolean));
	const chosen = STEPS.filter(step => asked.has(step.key) || has(step.flag));
	let steps = chosen.length > 0 ? chosen : STEPS.filter(step => step.byDefault);

	// Полный обход статистики спрашивает и про новых тоже: делать рядом с ним ещё
	// и короткий проход означало бы спросить их дважды
	if (steps.some(step => step.key === 'stats')) {
		steps = steps.filter(step => step.key !== 'statsnew');
	}

	// Проценты и описания вместе — это один шаг, а не два: вопрос к модели у них
	// общий (список тем пака), и задать его дважды означало бы вдвое быстрее
	// исчерпать суточный лимит, который считает запросы (см. refreshAnalysis)
	if (steps.some(step => step.key === 'topics') && steps.some(step => step.key === 'summary')) {
		const analyze = STEPS.find(step => step.key === 'analyze');
		steps = steps.filter(step => step.key !== 'topics' && step.key !== 'summary');
		steps = [...steps, analyze].sort((a, b) => STEPS.indexOf(a) - STEPS.indexOf(b));
	}

	// Обсуждение по автору или по номеру пака не спрашивают: обход ВК читает тему
	// целиком, и сузить его нечем. Точечное обновление — это про то, что уже
	// в базе, поэтому шаг молча не пропускается, а называется вслух
	if (targeted && steps.some(step => step.key === 'vk')) {
		console.log('[ВК] обход обсуждений пропускаю: названы отдельные паки, а тему по ним не отобрать.');
		steps = steps.filter(step => step.key !== 'vk');
	}

	return steps;
}

const steps = selectedSteps();
const chosenKeys = new Set(steps.map(step => step.key));
const finished = new Set();

/**
 * Работает ли ещё шаг, который может подкинуть работы. Шаг, не выбранный в этот
 * запуск, не работает по определению: разбор в одиночку не должен ждать обхода ВК,
 * которого никто не просил.
 */
const isRunning = key => chosenKeys.has(key) && !finished.has(key);

for (const step of steps) {
	tracks.set(step.key, new Track(step.key));
}

report({ plan: steps.map(step => ({ key: step.key, name: step.name })) });

let broke = false;

/** Один шаг: дождаться тех, после кого положено, сделать своё, отметиться. */
async function runStep(step, waitFor) {
	await Promise.all(waitFor);
	report({ step: step.key, state: 'start' });

	try {
		await step.run();
	} catch (error) {
		broke = true;
		console.error(`[${TAGS[step.key]}] шаг сорвался: ${error.message}`);
	} finally {
		finished.add(step.key);
		track(step.key).finish();
	}
}

const started = new Map();

for (const step of steps) {
	// Ждать надо только тех, кого в этот запуск действительно позвали
	const waitFor = (step.after ?? [])
		.filter(key => chosenKeys.has(key))
		.map(key => started.get(key))
		.filter(Boolean);

	// Последовательный режим ждёт всех, кто уже запущен: это и есть прежний порядок
	started.set(step.key, runStep(step, serial ? [...started.values()] : waitFor));
}

await Promise.all(started.values());

printSummary();

// Сорвавшийся шаг не должен выглядеть удачным запуском: по коду выхода ночной
// обход решает, выкладывать ли собранное наверх (см. scripts/nightly.js).
if (broke) {
	process.exitCode = 1;
}
