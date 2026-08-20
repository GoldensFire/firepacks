// Страница раздела: /topic/anime, /subjects/dota.
//
// Зачем она есть. Раздел был и раньше — отбором в адресе библиотеки
// (/?topic=anime), — но своей страницей не был: заголовок вкладки, описание
// и канонический адрес у него были общие с главной, то есть на языке поисковика
// раздела не существовало вовсе. Теперь у каждой тематики и у каждого типа
// паков свой адрес, свой заголовок и свой текст (см. injectLandingMeta
// в src/meta.js), а здесь — то, что видит человек: та же выдача, что
// и в библиотеке, только уже отобранная.
//
// Своей вёрстки у страницы почти нет: паки рисует та же самая карточка, что
// и в библиотеке, и на странице пака (см. card.js). Фильтров слева тут нет
// нарочно — за ними ссылка в библиотеку, где отбор уже поставлен: раздел
// отвечает на вопрос «что тут есть», а не «покажи мне ровно вот это».

'use strict';

/** Сколько паков на странице. Столько же, сколько в библиотеке. */
const PAGE_SIZE = 24;

/**
 * Что за раздел открыт. Кладёт сюда сервер, разобрать это из адреса нельзя:
 * у типа пака в адресе стоит ключ («garri-potter»), а отбор выдачи идёт
 * по названию («Гарри Поттер»), и перевод одного в другое знает только тот,
 * у кого на руках весь сведённый список типов.
 */
const landing = JSON.parse($('landingState')?.textContent ?? '{}');

/** Какая страница выдачи открыта. Стоит в адресе, чтобы ссылкой можно было делиться. */
let page = Math.max(parseInt(new URLSearchParams(window.location.search).get('page') ?? '1', 10) || 1, 1);

/**
 * Нажали на автора, тип пака, тему или повтор прямо в карточке. Отбирать здесь
 * нечего — страница показывает один раздел, — поэтому вопрос «покажи такие же»
 * уводит в библиотеку, которая читает фильтры прямо из адреса (см. readUrlState
 * в app.js). Так же поступают страница пака и топ.
 */
function pickFilter(kind, value) {
	const names = { author: 'author', topic: 'topic', tag: 'tag', franchise: 'franchise', subject: 'subject' };
	window.location.href = `/?${names[kind]}=${encodeURIComponent(value)}`;
}

/** Отметки на этой странице ничего за пределами карточки не меняют. */
function onPlayedChange() {}
function onPlannedChange() {}

// Уголок входа и счётчики шапки живут в common.js: шапка одна на весь сайт,
// и наполняется она везде одинаково (см. renderTopbar).

/**
 * Заголовок раздела и строка под ним — на месте серверной заготовки.
 *
 * Заготовку затираем целиком: в ней лежит тот же заголовок, тот же абзац
 * и список паков ссылками, и оставить её значило бы показать человеку список
 * дважды — сперва голыми ссылками, потом карточками.
 */
function renderHead() {
	const box = $('landing');
	box.textContent = '';

	box.append(
		element('h1', 'top__heading', landing.heading ?? 'Раздел библиотеки'),
		element('p', 'hint', landing.hint ?? ''),
	);

	// Ссылка в библиотеку с уже поставленным отбором. Нужна не для красоты:
	// раздел показывает выдачу как есть, а сортировки, сложности, языки
	// и всё остальное живут там — и человека, которому мало верхушки, надо
	// увести туда одним нажатием, а не заставлять собирать отбор заново.
	if (landing.query) {
		const all = element('p', 'hint');
		const link = element('a', null, `Открыть в библиотеке со всеми фильтрами`);

		link.href = `/?${landing.query}`;
		all.append(link);
		box.append(all);
	}
}

/** Запрос выдачи раздела: та же, что и в библиотеке, только отбор задан адресом. */
function buildQuery() {
	const query = new URLSearchParams(landing.query ?? '');

	query.set('page', String(page));
	query.set('pageSize', String(PAGE_SIZE));
	// Паки без оценки сложности прятать не за что: сложность считается
	// по статистике игр и есть далеко не у всех, а раздел обещает все паки
	// раздела — и число в заголовке посчитано по всем
	query.set('unrated', '1');

	return query;
}

/**
 * Показать выдачу раздела.
 *
 * Ответ можно передать уже запрошенным: при первом заходе ходка за паками
 * уходит вместе с ходкой за настройками, а рисовать выдачу до настроек нельзя —
 * карточка спрашивает у них имена ярлыков и пороги (см. topicInfo в card.js).
 */
async function show(started) {
	const box = $('list');

	if (!started) {
		box.textContent = '';
		box.append(element('div', 'empty', 'Загрузка…'));
	}

	shownCards = [];

	const data = await (await (started ?? fetch(`/api/packages?${buildQuery()}`))).json();
	const packs = data.packages ?? [];

	box.textContent = '';

	if (packs.length === 0) {
		box.append(element('div', 'empty', 'В этом разделе пока ничего нет. '
			+ 'Загляните в библиотеку — там вся база целиком.'));
		return;
	}

	for (const pack of packs) {
		const card = createCard(pack);

		shownCards.push({ pack, card });
		box.append(card);
	}

	measureDescriptions();

	// Постраничность та же, что в библиотеке. Страница живёт в адресе: кнопка
	// «назад» возвращает к прежней, а ссылкой на третью страницу можно
	// поделиться — сюда за этим и ходят.
	renderPages($('pager'), {
		page: data.page,
		pageSize: data.pageSize,
		total: data.total,
		onGo: next => {
			page = next;
			window.history.pushState({}, '', page > 1 ? `${window.location.pathname}?page=${page}` : window.location.pathname);
			show();
			window.scrollTo({ top: 0, behavior: 'smooth' });
		},
	});
}

window.addEventListener('popstate', () => {
	page = Math.max(parseInt(new URLSearchParams(window.location.search).get('page') ?? '1', 10) || 1, 1);
	show();
});

// Описания обрезаются по высоте, и мерить их надо заново, когда ширина карточки
// изменилась, — так же, как в библиотеке
let resizeTimer = null;

window.addEventListener('resize', () => {
	clearTimeout(resizeTimer);
	resizeTimer = setTimeout(measureDescriptions, 200);
});

async function start() {
	loadLocalMarks();
	bindTopbarSearch();

	// Заголовок ставим сразу, не дожидаясь выдачи: он уже приехал вместе
	// со страницей, и держать человека перед словом «Загрузка…» там, где
	// ответ давно есть, незачем
	renderHead();

	// Обе ходки уходят разом: выдаче настройки не нужны, чтобы быть запрошенной.
	// А вот чтобы быть нарисованной — нужны, и потому рисуется она после них.
	const packages = fetch(`/api/packages?${buildQuery()}`);

	facets = await (await fetch('/api/facets')).json();
	user = facets.user ?? null;

	renderTopbar(facets);
	await show(packages);
}

start();
