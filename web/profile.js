// Профиль: кто ты, во что играл и что из этого видно про вкусы.
//
// Страница открывается собой — именем, числами, полосой времени и разбивкой
// по сложностям и типам паков. Списки паков лежат за вкладками рядом и грузятся
// по нажатию: раньше они занимали страницу целиком, а сам профиль ютился
// в колонке справа, и открытие «моего профиля» начиналось с двух сотен карточек,
// которые никто не просил.
//
// ————— списки —————
//
// «Сыграно» и «Запланировано» здесь не свой урезанный список, а та же выдача,
// которой живёт библиотека: те же карточки со всем, что на них есть, тот же
// поиск, та же колонка фильтров справа. Заводится она отсюда, с закреплённым
// отбором — onlyPlayed или onlyPlanned (см. pinMarks и mountLibrary в web/app.js).
//
// До этого профиль рисовал карточки сам, и они были короче библиотечных: без
// оценки, без долей тематик, без повторов, без кнопки «спрятать». Второе описание
// одного и того же всегда расходится с первым, и разошлось оно ровно так.
//
// Имя берётся из Discord, если человек вошёл. Без входа остаётся прежняя подпись
// из localStorage: сайт задумывался как локальный, и требовать учётную запись
// ради страницы «во что я играл» не за что.

'use strict';

// LEVEL_ORDER и TOPIC_ORDER объявляет библиотека, topicInfo и EXTRA_TOPICS —
// карточка, а facets с user общие на весь сайт (см. web/card.js и web/common.js).
// Своих копий здесь нет нарочно: разойдись они, и один и тот же тип пака
// назывался бы на двух страницах по-разному.

/** Как человек себя назвал. Ничего, кроме подписи, за этим именем не стоит. */
const NAME_KEY = 'firepacks.profile.name';

/**
 * По столько секунд считается каждый вопрос сыгранного пака. Число взято не
 * из статистики, а из здравого смысла: вопрос читают, думают над ним, отвечают,
 * спорят с ответом и записывают очки, — и на круг это выходит треть минуты.
 * Настоящей длительности игры сайт не знает и знать не может: он видит только
 * файлы паков.
 */
const SECONDS_PER_QUESTION = 20;

/**
 * Ступени полосы времени. Стоят они на равном расстоянии друг от друга, а не
 * по-настоящему: между «1 час» и «1 месяц» семисоткратная разница, и на честной
 * шкале первые четыре отметки слиплись бы в одну точку у левого края. Полоса
 * здесь не измеряет, а показывает, куда человек продвинулся.
 */
const TIME_MARKS = [
	{ label: '1 час', seconds: 3600 },
	{ label: '6 часов', seconds: 6 * 3600 },
	{ label: '1 день', seconds: 24 * 3600 },
	{ label: '3 дня', seconds: 3 * 24 * 3600 },
	{ label: '1 неделя', seconds: 7 * 24 * 3600 },
	{ label: '1 месяц', seconds: 30 * 24 * 3600 },
	// Месяцем шкала кончаться перестала: у того, кто набрал за ней ещё столько же,
	// последняя отметка стояла пройденной, и дальше полоса не двигалась вовсе
	{ label: '3 месяца', seconds: 90 * 24 * 3600 },
];

/** Единицы для подписи «2 дня и 4 часа». Сверху вниз, от крупных к мелким. */
const DURATION_UNITS = [
	{ seconds: 30 * 24 * 3600, one: 'месяц', few: 'месяца', many: 'месяцев' },
	{ seconds: 7 * 24 * 3600, one: 'неделя', few: 'недели', many: 'недель' },
	{ seconds: 24 * 3600, one: 'день', few: 'дня', many: 'дней' },
	{ seconds: 3600, one: 'час', few: 'часа', many: 'часов' },
	{ seconds: 60, one: 'минута', few: 'минуты', many: 'минут' },
];

/** Числа профиля и чёрный список: всё, что отвечает /api/profile. */
let profile = null;

/**
 * Что открыто. Переживает перерисовку страницы и стоит в адресе: ссылка на свои
 * планы должна открывать планы, а не профиль с планами за вкладкой.
 *
 * Профиль открыт по умолчанию — за ним сюда и приходят. Счётчик «Сыграно»
 * в шапке (см. renderTopbarCounters в web/common.js) по-прежнему ведёт сразу
 * на сыгранное: тот, кто нажал на число, просит список, а не разбивку.
 */
const TABS = {
	profile: { button: 'tabProfile', panel: 'profilePanel' },
	planned: { button: 'tabPlanned', panel: 'listPanel' },
	played: { button: 'tabPlayed', panel: 'listPanel' },
	banPacks: { button: 'tabBanPacks', panel: 'banPacksPanel' },
	banAuthors: { button: 'tabBanAuthors', panel: 'banAuthorsPanel' },
};

const askedTab = new URLSearchParams(window.location.search).get('tab');

let tab = Object.hasOwn(TABS, askedTab ?? '') ? askedTab : 'profile';

/**
 * Заведена ли уже библиотека под списки. Заводится она один раз и лениво:
 * до первого открытия списка ходить за выдачей незачем, а после — незачем
 * заводить её заново, переключение вкладки это просто другой отбор.
 */
let listMounted = false;

/**
 * Шапка профиля. У вошедшего это имя и аватар из Discord, менять их здесь нечего:
 * они приходят оттуда. Без входа остаётся прежняя подпись из localStorage — она
 * ничего не значит, кроме того, как обращаться к человеку на его же странице.
 */
function renderWho() {
	const avatar = $('avatar');
	const name = $('userName');
	// Свой, а не тот, что в шапке: там уголок входа на всех страницах одинаковый,
	// а здесь он стоит под именем и аватаром — на своей же странице
	const account = $('profileAccount');

	avatar.textContent = '';
	account.textContent = '';

	if (user) {
		name.textContent = user.name;
		name.title = 'Имя из Discord';
		name.classList.remove('profile__name--editable');

		if (user.avatar) {
			const image = element('img', 'profile__avatar-image');
			image.src = user.avatar;
			image.alt = '';
			avatar.append(image);
		} else {
			avatar.textContent = user.name.trim().charAt(0).toUpperCase() || '?';
		}

		$('userHint').textContent = 'Вход через Discord. Оценки паков и чёрный список привязаны к этой учётной записи.';

		const out = element('button', 'button button--ghost', 'Выйти');
		out.type = 'button';
		out.addEventListener('click', async () => {
			await fetch('/auth/logout', { method: 'POST' });
			window.location.reload();
		});

		account.append(out);
		return;
	}

	const local = localStorage.getItem(NAME_KEY) || 'Игрок';

	name.textContent = local;
	name.title = 'Нажмите, чтобы изменить имя';
	name.classList.add('profile__name--editable');
	avatar.textContent = local.trim().charAt(0).toUpperCase() || '?';

	$('userHint').textContent = 'Имя хранится только в этом браузере и ни на что, кроме подписи, не влияет.';

	if (facets?.hasDiscord) {
		const login = element('a', 'button button--discord', 'Войти через Discord');
		login.href = '/auth/discord';
		login.title = 'После входа появятся оценки паков и личный чёрный список';
		account.append(login);
	}
}

function bindWho() {
	$('userName').addEventListener('click', () => {
		// У вошедшего имя приходит из Discord, и переписывать его здесь нечем
		if (user) {
			return;
		}

		const chosen = prompt('Как вас называть?', localStorage.getItem(NAME_KEY) || 'Игрок');

		if (chosen !== null) {
			localStorage.setItem(NAME_KEY, chosen.trim().slice(0, 40) || 'Игрок');
			renderWho();
		}
	});
}

/**
 * Личные чёрные списки — паки и авторы порознь, по вкладке на каждый.
 *
 * Порознь потому, что это и есть два разных списка: спрятанный пак уходит
 * из выдачи один, спрятанный автор уносит с собой все свои. Вместе они читались
 * одной кучей значков, где не видно, чего в ней больше.
 *
 * Вкладок нет вовсе у того, кому прятать нечем: без входа на общем сайте
 * чёрного списка не существует.
 */
function renderBlacklist() {
	const items = profile.blacklist ?? [];

	// Без входа список тоже бывает: на своей машине он принадлежит установке,
	// как и отметки «сыграно» (см. config.localBlacklist)
	const visible = serverMarks();

	for (const [kind, box, button, count, empty] of [
		['pack', 'blacklist', 'tabBanPacks', 'tabBanPacksCount', 'Спрятанных паков пока нет.'],
		['author', 'blacklistAuthors', 'tabBanAuthors', 'tabBanAuthorsCount', 'Спрятанных авторов пока нет.'],
	]) {
		const mine = items.filter(item => (kind === 'author' ? item.kind === 'author' : item.kind !== 'author'));

		$(button).hidden = !visible;
		$(count).textContent = formatNumber(mine.length);

		const container = $(box);
		container.textContent = '';

		if (mine.length === 0) {
			container.append(element('p', 'hint', empty));
			continue;
		}

		for (const item of mine) {
			container.append(createBanChip(item));
		}
	}
}

/** Одна строка чёрного списка: что спрятано и крестик, который это возвращает. */
function createBanChip(item) {
	const chip = element('span', 'profile__chip');
	chip.append(iconText(item.kind === 'author' ? 'user' : 'box', item.label));

	const remove = element('button', 'chip-x', '✕');
	remove.type = 'button';
	remove.title = 'Вернуть в выдачу';
	remove.addEventListener('click', async () => {
		remove.disabled = true;

		await fetch('/api/blacklist', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ kind: item.kind, value: item.value, blacklisted: false }),
		});

		await refresh();
	});

	chip.append(remove);
	return chip;
}

/**
 * Крупные числа профиля: сколько всего сыграно и что за этим стоит. Два из трёх —
 * кнопки: за числом «205 паков сыграно» стоит список, и ходить за ним к вкладкам,
 * когда число под рукой, незачем.
 */
function renderNumbers() {
	const box = $('numbers');
	box.textContent = '';

	const played = profile.total ?? 0;
	const planned = profile.plannedTotal ?? 0;
	const share = facets.total > 0 ? Math.round((played / facets.total) * 100) : 0;

	const add = (value, label, title, goes = null) => {
		const item = element(goes ? 'button' : 'div', goes ? 'profile__number profile__number--link' : 'profile__number');
		item.append(element('span', 'profile__number-value', value), element('span', 'profile__number-label', label));
		item.title = title;

		if (goes) {
			item.type = 'button';
			item.addEventListener('click', () => openTab(goes));
		}

		box.append(item);
	};

	add(formatNumber(played), plural(played, 'пак сыгран', 'пака сыграно', 'паков сыграно'),
		'Открыть список сыгранного. Копии одного и того же пака считаются за один', 'played');
	add(formatNumber(planned), plural(planned, 'пак в планах', 'пака в планах', 'паков в планах'),
		'Открыть список отложенного на будущее', 'planned');
	add(`${share}%`, 'от всей библиотеки', `Всего в библиотеке ${formatNumber(facets.total)} паков`);
	add(formatNumber(profile.questions), plural(profile.questions, 'вопрос', 'вопроса', 'вопросов'),
		'Столько вопросов лежит в сыгранных паках — не столько прозвучало за столом');
}

/**
 * Подпись длительности: две старшие непустые единицы, «2 дня и 4 часа».
 * Одной мало (между «1 днём» и «2 днями» помещается почти сутки), трёх много —
 * минуты рядом с месяцами уже ничего не добавляют.
 */
function formatDuration(seconds) {
	let rest = Math.max(0, Math.round(seconds));
	const parts = [];

	for (const unit of DURATION_UNITS) {
		const count = Math.floor(rest / unit.seconds);

		// Нули впереди пропускаем, ноль после первой единицы кончает разбор:
		// «2 дня» лучше, чем «2 дня и 0 часов»
		if (count === 0) {
			if (parts.length === 0) {
				continue;
			}

			break;
		}

		parts.push(`${formatNumber(count)} ${plural(count, unit.one, unit.few, unit.many)}`);
		rest -= count * unit.seconds;

		if (parts.length === 2) {
			break;
		}
	}

	return parts.length > 0 ? parts.join(' и ') : 'меньше минуты';
}

/**
 * Полоса времени: во сколько часов обошлось сыгранное. Устроена как шкала
 * с отметками — пройденные помечены галочкой, — и заполняется по отрезкам:
 * внутри отрезка заливка идёт ровно, а сами отрезки одной ширины (см. TIME_MARKS).
 *
 * Считается это всё по SECONDS_PER_QUESTION на вопрос, и число получается
 * заведомо приблизительное. Поэтому у подписи есть подсказка, где расчёт назван
 * прямо: человек должен видеть, что перед ним прикидка, а не показания секундомера.
 */
function renderTime() {
	const questions = profile.questions;

	// Пустая полоса у того, кто ещё ничего не отметил, — обещание без содержания:
	// показывать ему шкалу от часа до месяца незачем
	$('timeline').hidden = questions === 0;

	if (questions === 0) {
		return;
	}

	const seconds = questions * SECONDS_PER_QUESTION;

	// Часы в скобках рядом с «2 дня и 4 часа»: дни и недели показывают порядок
	// величины, а сравнивают всё равно часами — в них меряют и вечер за столом,
	// и наигранное в любой другой игре
	const hours = Math.round(seconds / 3600);
	const total = `${formatDuration(seconds)} (${formatNumber(hours)} ${plural(hours, 'час', 'часа', 'часов')})`;

	$('timeValue').textContent = total;

	// Подсказка короткая нарочно: она отвечает на единственный вопрос, который
	// к этому числу возникает, — откуда оно взялось
	const explain = `Количество вопросов умноженное на ${SECONDS_PER_QUESTION} с`;

	$('timeTitle').title = explain;
	$('timeValue').title = explain;

	const bar = $('timeBar');
	const marks = $('timeMarks');

	bar.textContent = '';
	marks.textContent = '';

	let low = 0;

	for (const mark of TIME_MARKS) {
		const passed = seconds >= mark.seconds;
		const filled = Math.min(1, Math.max(0, (seconds - low) / (mark.seconds - low)));

		const segment = element('div', 'timeline__segment');
		const fill = element('div', 'timeline__fill');
		fill.style.width = `${filled * 100}%`;
		segment.append(fill);
		bar.append(segment);

		const label = element('div', passed ? 'timeline__mark timeline__mark--passed' : 'timeline__mark');

		if (passed) {
			label.append(icon('check'));
		}

		label.append(element('span', null, mark.label));
		label.title = `${mark.label} игры — это примерно ${formatNumber(Math.round(mark.seconds / SECONDS_PER_QUESTION))} вопросов`;
		marks.append(label);

		low = mark.seconds;
	}
}

/** Числа на вкладках. Стоят там до того, как вкладку открыли, — за тем и нужны. */
function renderTabCounts() {
	$('tabPlannedCount').textContent = formatNumber(profile?.plannedTotal ?? 0);
	$('tabPlayedCount').textContent = formatNumber(profile?.total ?? 0);
}

/**
 * Показать то, что выбрано. Колонка фильтров при этом появляется и пропадает
 * вместе со списками: в самом профиле и в чёрных списках фильтровать нечего,
 * а пустая колонка сбоку выглядит поломкой.
 */
function renderTabs() {
	for (const [key, { button, panel }] of Object.entries(TABS)) {
		const active = key === tab;

		$(button).classList.toggle('tab--active', active);
		$(button).setAttribute('aria-selected', String(active));
		// Панель у списков одна на две вкладки: показать её надо, если открыта
		// любая из них, а спрятать — только когда обе закрыты
		$(panel).hidden = true;
	}

	$(TABS[tab].panel).hidden = false;

	const list = tab === 'played' || tab === 'planned';

	$('filters').hidden = !list;
	$('page').classList.toggle('layout--filters', list);
}

/**
 * Открыть вкладку. Списки при этом заводятся лениво и один раз: до первого
 * открытия ходить за выдачей незачем, а дальше переключение — это просто другой
 * закреплённый отбор, и перезаводить ради него всю библиотеку не за чем.
 */
async function openTab(key) {
	tab = key;

	const url = new URL(window.location.href);

	if (key === 'profile') {
		url.searchParams.delete('tab');
	} else {
		url.searchParams.set('tab', key);
	}

	window.history.replaceState({}, '', url);
	renderTabs();

	if (key !== 'played' && key !== 'planned') {
		return;
	}

	// Отбирает по отметкам база, а до входа они лежат в самом браузере: списка
	// у сервера нет, и притворяться, что он пуст, нельзя — это разные вещи
	if (!serverMarks()) {
		showListLocked();
		return;
	}

	if (!listMounted) {
		listMounted = true;
		pinMarks(key);
		await mountLibrary();
		return;
	}

	pinMarks(key);
	state.page = 1;
	renderActiveFilters();
	load();
}

/**
 * Что показать вместо списка тому, кто не вошёл. Отметки у него есть — они лежат
 * в самом браузере (см. web/common.js), — но отбирать по ним умеет только база,
 * и молчать об этом нельзя: человек, отметивший вчера десяток паков, решит,
 * что они пропали.
 */
function showListLocked() {
	$('grid').textContent = '';
	$('resultInfo').textContent = '';
	$('pager').textContent = '';
	$('filters').hidden = true;
	$('page').classList.remove('layout--filters');

	$('grid').append(element('div', 'empty',
		'Списками заведует база, а до входа отметки живут в самом браузере и до неё не доходят. '
		+ 'Войдите через Discord — они переедут в учётную запись, и списки заработают.'));
}

function bindTabs() {
	for (const [key, { button }] of Object.entries(TABS)) {
		$(button).addEventListener('click', () => openTab(key));
	}
}

/** Разбивка сыгранного по сложности и по типу пака: чем ссылка, тем в библиотеку. */
function renderBreakdown(containerId, order, counts, info, href) {
	const box = $(containerId);
	box.textContent = '';

	let shown = 0;

	for (const key of order) {
		const count = counts[key] ?? 0;

		if (count === 0) {
			continue;
		}

		const chip = element('a', 'profile__chip');
		chip.href = href(key);
		// Значок рисуется чертежом, а не эмодзи: у сложности его нет вовсе,
		// у тематик — свой на каждую (см. icons.js)
		const { iconNode, name, className } = info(key);

		if (className) {
			chip.classList.add(className);
		}

		const label = element('span', 'icon-text');

		if (iconNode) {
			label.append(iconNode);
		}

		label.append(element('span', null, name));

		chip.append(label, element('span', 'profile__chip-count', String(count)));

		box.append(chip);
		shown++;
	}

	if (shown === 0) {
		box.append(element('p', 'hint', 'Пока ничего не отмечено.'));
	}
}

function renderAuthors() {
	const authors = profile.favouriteAuthors ?? [];

	$('authorsBlock').hidden = authors.length === 0;

	if (authors.length === 0) {
		return;
	}

	const box = $('favouriteAuthors');
	box.textContent = '';

	for (const author of authors) {
		const chip = element('a', 'profile__chip');
		// hidePlayed=0 — потому что эта строка про сыгранное, а библиотека сыгранное
		// по умолчанию прячет: без приписки под числом «сыграно 7 паков этого автора»
		// открывалась бы выдача, где именно этих семи и нет
		chip.href = `/?author=${encodeURIComponent(author.name)}&hidePlayed=0`;
		chip.append(
			element('span', null, author.name),
			element('span', 'profile__chip-count', String(author.count)),
		);
		chip.title = `Сыграно ${author.count} ${plural(author.count, 'пак', 'пака', 'паков')} этого автора`;
		box.append(chip);
	}
}

// ————— список файлом —————
//
// Формат описан там, где его читает сервер (см. src/packlist.js).
// Здесь только два конца: собрать файл из того, что знает сервер,
// и отдать принесённый файл ему же — опознать паки по названиям.

const LIST_FORMAT = 'sigame-pack-list';
const LIST_VERSION = 1;

/**
 * Как назвать скачиваемый файл: с датой, чтобы вчерашний не затирался сегодняшним.
 *
 * Имя это человек читает в папке загрузок, поэтому оно и переименовалось вместе
 * с сайтом. А вот поле «source» внутри самого файла осталось прежним нарочно:
 * оно не подпись, а часть формата обмена (см. src/packlist.js), и у файлов,
 * скачанных вчера, там по-прежнему написано «firepacks».
 */
const listFileName = () => `sifirepacks-${new Date().toISOString().slice(0, 10)}.json`;

/**
 * Записи файла. Порядок тот же, что в списках: сначала недавнее — файл читают
 * глазами, и сверху должно стоять то же самое, что стоит сверху на странице.
 */
function buildList(played, planned) {
	const entry = (pack, kind) => ({
		name: pack.name ?? pack.fileName ?? '',
		authors: pack.authors ?? [],
		list: kind,
		...(pack.markedAt ? { markedAt: new Date(pack.markedAt).toISOString() } : {}),
	});

	return {
		format: LIST_FORMAT,
		version: LIST_VERSION,
		exportedAt: new Date().toISOString(),
		source: 'firepacks',
		packages: [
			...played.map(pack => entry(pack, 'played')),
			...planned.map(pack => entry(pack, 'planned')),
		],
	};
}

/**
 * Что вывозить. У вошедшего (и дома, где отметки принадлежат установке) списки
 * знает сервер, и спрашиваются они целиком. До входа на общем сайте отметки лежат
 * в браузере одними ключами, и названия к ним приходится спрашивать отдельно —
 * в файл идёт то, что человек прочитает, а не «b88b8a6e…\nАниме пак № 5».
 */
async function collectList() {
	if (serverMarks()) {
		const all = await fetch('/api/profile?export=1').then(r => r.json());

		return buildList(all.packages ?? [], all.planned ?? []);
	}

	loadLocalMarks();

	const keys = [...new Set([...localPlayed, ...localPlanned])];

	if (keys.length === 0) {
		return buildList([], []);
	}

	const named = await fetch('/api/list', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ keys }),
	}).then(r => r.json());

	const byKey = new Map((named.packages ?? []).map(pack => [pack.key, pack]));
	const pick = set => [...set].map(key => byKey.get(key)).filter(Boolean);

	return buildList(pick(localPlayed), pick(localPlanned));
}

/**
 * Разбор принесённого файла. JSON — свой; всё остальное считается простым
 * списком названий по строке на пак: такой список человек и сам наберёт
 * в блокноте, и отказывать ему было бы придиркой.
 */
function parseList(text) {
	try {
		return JSON.parse(text);
	} catch {
		return {
			packages: text.split(/\r?\n/)
				.map(line => line.trim())
				.filter(line => line && !line.startsWith('#'))
				.map(name => ({ name })),
		};
	}
}

function saveFile(name, text) {
	const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
	const link = element('a');

	link.href = url;
	link.download = name;
	link.click();

	URL.revokeObjectURL(url);
}

/**
 * Отметить найденное. Сервер только опознаёт паки (см. /api/list), а отмечаются
 * они как всегда — тем же способом, каким отмечает кнопка на карточке: у кого
 * отметки хранит сервер, тому на сервер, остальным в браузер.
 */
async function applyMatched(matched) {
	if (!serverMarks()) {
		loadLocalMarks();

		for (const key of matched.played) {
			localPlayed.add(key);
		}

		for (const key of matched.planned) {
			localPlanned.add(key);
		}

		saveLocalPlayed();
		saveLocalPlanned();
		return;
	}

	const send = (url, body) => fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});

	// Даты отметок идут вместе с ключами: в файле у каждого пака своё время,
	// и проставить всем сегодняшнее значило бы стереть, когда в них играли
	const { markedAt } = matched;

	// Сыгранное — первым: отметка «сыграно» убирает пак из планов (см. setPlayed
	// на сервере), и порядок наоборот вычёркивал бы только что отмеченное
	if (matched.played.length > 0) {
		await send('/api/played', { packKeys: matched.played, played: true, markedAt });
	}

	if (matched.planned.length > 0) {
		await send('/api/planned', { packKeys: matched.planned, planned: true, markedAt });
	}
}

function bindList() {
	const hint = $('listHint');
	const file = $('listFile');

	$('listExport').addEventListener('click', async () => {
		const list = await collectList();

		if (list.packages.length === 0) {
			hint.textContent = 'Вывозить нечего: ни одного пака пока не отмечено.';
			return;
		}

		// С отступами и без \u-экранирования: файл должен читаться глазами
		saveFile(listFileName(), JSON.stringify(list, null, '\t'));

		hint.textContent = `В файле ${list.packages.length} `
			+ `${plural(list.packages.length, 'пак', 'пака', 'паков')}: название, авторы и дата отметки.`;
	});

	$('listImport').addEventListener('click', () => file.click());

	file.addEventListener('change', async () => {
		const chosen = file.files?.[0];

		if (!chosen) {
			return;
		}

		hint.textContent = 'Читаем файл…';

		try {
			const matched = await fetch('/api/list', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(parseList(await chosen.text())),
			}).then(r => r.json());

			if (matched.error) {
				hint.textContent = matched.error;
				return;
			}

			await applyMatched(matched);

			const found = matched.played.length + matched.planned.length;

			// Про ненайденное говорим прямо и с примерами: пак мог называться иначе
			// или его может не быть в этой библиотеке вовсе, и молчать об этом нельзя
			hint.textContent = `Отмечено ${found} из ${matched.total}.`
				+ (matched.missed.length > 0
					? ` Не нашлось ${matched.missed.length}: ${matched.missed.slice(0, 3).join(', ')}`
						+ `${matched.missed.length > 3 ? ' и другие' : ''}.`
					: '');

			await refresh();
		} catch {
			hint.textContent = 'Файл прочитать не вышло: ждём JSON или список названий по строке на пак.';
		} finally {
			// Иначе тот же файл второй раз выбрать нельзя: событие не повторится
			file.value = '';
		}
	});
}

/**
 * Перечитать профиль: числа, разбивку и чёрные списки. Зовётся при открытии
 * страницы и после каждой правки — ввоза списка файлом, возврата из чёрного
 * списка. Ответ здесь короткий: паков в нём нет ни одного, они приезжают
 * выдачей (см. getProfile в cf/src/library.js).
 */
async function refresh() {
	[facets, profile] = await Promise.all([
		fetch('/api/facets').then(r => r.json()),
		fetch('/api/profile').then(r => r.json()),
	]);

	user = facets.user ?? null;

	renderTopbar(facets);
	renderWho();
	renderNumbers();
	renderTime();
	renderTabCounts();

	renderBreakdown('playedLevels', LEVEL_ORDER, profile.levels,
		key => ({ name: facets.levelNames[key].name, className: `level--${facets.levelNames[key].key}` }),
		key => `/?levels=${key}&hidePlayed=0`);

	// Здесь стоит вопрос «сколько паков какого типа сыграно», и отвечает на него
	// packName — «Аниме-пак», а не «Аниме» (то же правило, что в web/app.js)
	renderBreakdown('playedTopics', TOPIC_ORDER, profile.topics,
		key => ({ name: topicInfo(key).packName, iconNode: topicIcon(key), className: `topic--${key}` }),
		key => `/?topic=${encodeURIComponent(key)}&hidePlayed=0`);

	renderAuthors();
	renderBlacklist();

	// Список уже открыт и на нём что-то отметили — перечитаем и его: числа
	// на вкладках уже новые, и списку отставать от них незачем
	if (listMounted && (tab === 'played' || tab === 'planned')) {
		load();
	}
}

async function start() {
	// Имя ставится дважды: сразу — из localStorage, чтобы страница не начиналась
	// с пустой шапки, и ещё раз в refresh(), когда станет известно, вошёл ли кто
	renderWho();
	bindWho();
	bindTabs();
	bindList();
	bindTopbarSearch();
	loadLocalMarks();
	renderTabs();

	await refresh();

	// Вкладку могли попросить прямо адресом — /profile?tab=played из шапки.
	// Открываем её только теперь: до ответа не известно даже, есть ли чем
	// отбирать по отметкам
	if (tab !== 'profile') {
		await openTab(tab);
	}
}

start();
