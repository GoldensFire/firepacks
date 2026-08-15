// Топ авторов паков: у кого их играют больше всех.
//
// Считается по статистике SIGame — по числу запусков, а не по числу паков:
// десять паков, которые никто не открыл, значат меньше одного, сыгранного
// тысячу раз. Число паков стоит рядом, чтобы разница была видна.
//
// Что означает период — см. renderHint: окно подсчёта самих игр сервис
// статистики отдавать не умеет, и период отбирает паки, а не игры.

'use strict';

/**
 * Страница, поиск и период. Список приезжает с сервера целиком — в нём все, кто
 * подписал хоть один пак, — а делит его на страницы и отбирает по имени сам
 * браузер: пять тысяч строк это несколько сотен килобайт, они уже здесь,
 * и ходить за каждой страницей на сервер незачем.
 */
const state = { period: 'all', page: 1, search: '', sort: 'games' };

/** Сколько авторов на странице. Двести — столько же, сколько было во всём топе, когда он обрывался. */
const PAGE_SIZE = 200;

let data = null;

const PERIOD_NAMES = {
	all: 'за всё время',
	year: 'за год',
	half: 'за полгода',
	month: 'за месяц',
};

const PERIOD_DAYS = { year: 365, half: 182, month: 30 };

/**
 * По чему считать топ. Число игр отвечает на вопрос «кого играют больше всех»,
 * и человек с тремя сотнями паков стоит в нём выше того, чей единственный пак
 * разошёлся по всему СНГ. Среднее за пак отвечает на другой вопрос — «чей пак
 * стоит взять наугад», — и топ по нему выглядит совсем иначе.
 *
 * Сортировка идёт по всему списку, а не по странице: он приезжает целиком.
 * Места считаются заново под выбранный порядок — «третий по среднему» и «третий
 * по числу игр» это разные третьи, и показывать под ними одно и то же место
 * было бы враньём.
 */
const SORTS = {
	games: author => author.games,
	average: author => averageOf(author),
	packs: author => author.packs,
};

const SORT_NAMES = {
	games: 'по числу игр',
	average: 'по играм в среднем за пак',
	packs: 'по числу паков',
};

/** Сколько игр приходится на один пак автора. */
function averageOf(author) {
	return author.packs > 0 ? author.games / author.packs : 0;
}

/**
 * Среднее словами. Дробная часть нужна только маленьким числам: «3,4 игры
 * на пак» и «3 игры на пак» — разные вещи, а «1247,3» — то же самое, что «1247»,
 * только длиннее.
 */
function formatAverage(value) {
	return value >= 10 ? formatNumber(Math.round(value)) : (Math.round(value * 10) / 10).toLocaleString('ru-RU');
}

/**
 * Отсортированный список держим готовым: он не меняется, пока не сменились
 * порядок или период, а перекладывать пять тысяч строк на каждую букву в поиске
 * незачем. Сбрасывается в null — «пересортировать при следующем показе».
 */
let ordered = null;

function ordering() {
	if (!ordered) {
		ordered = ranked();
	}

	return ordered;
}

/** Список в выбранном порядке, с проставленными местами. */
function ranked() {
	const by = SORTS[state.sort] ?? SORTS.games;

	return [...data.authors]
		.sort((a, b) => by(b) - by(a) || b.games - a.games || a.name.localeCompare(b.name, 'ru'))
		.map((author, index) => ({ ...author, place: index + 1 }));
}

/** Начало периода: «за год» — это паки, выложенные после этой даты. */
function periodStart(days) {
	return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toLocaleDateString('ru-RU');
}

function renderHint() {
	const days = PERIOD_DAYS[state.period];

	// Список полный: в нём все, кто подписал хоть один пак, а не первые двести.
	// Об этом стоит сказать прямо — иначе конец списка, где у всех по нулю игр,
	// выглядит как недосмотр, а не как ответ на вопрос «а я тут вообще есть».
	// Страницами он режется здесь же, в браузере: сам список приезжает разом.
	const found = matching();
	const all = state.search
		? `Найдено авторов: ${formatNumber(found.length)} из ${formatNumber(data.total)}. Места — из общего топа. `
		: `Всего авторов: ${formatNumber(data.total)}, по ${PAGE_SIZE} на странице — список полный, а не первая сотня. `;

	// Среднее за пак спрашивают не о том же, о чём общее число игр, и об этом
	// стоит сказать прямо: наверху такого топа стоят авторы с одним-двумя паками,
	// и без объяснения это выглядит ошибкой, а не ответом
	const mean = state.sort === 'average'
		? 'Порядок — по играм в среднем за пак: сколько раз запускали типичный пак автора, а не все его паки вместе. '
			+ 'Поэтому наверху бывает и тот, у кого пак всего один: список отвечает на вопрос «чей пак стоит взять наугад». '
		: '';

	$('periodHint').textContent = all + mean + (days
		? `Считаются паки, выложенные в обсуждение после ${periodStart(days)}, а игры у них — за всё время: `
			+ 'сколько раз пак запускали именно за период, сервис статистики не сообщает. '
			+ 'То есть это «чьи свежие паки играют больше всех», а не «кого больше играли этой весной».'
		: 'Считаются все паки автора и все их игры по данным статистики SIGame. '
			+ 'Копии одного и того же пака считаются за один. Составная подпись вроде '
			+ '«Vieldy, Pa4ok, Slime» разбирается на людей: пак засчитывается каждому.');
}

/** Одна строка таблицы. Место, имя, число паков и число игр. */
function createRow(author) {
	const row = element('a', 'authors__row');
	row.href = `/?author=${encodeURIComponent(author.name)}`;
	row.title = `Показать все паки автора «${author.name}»`;

	const place = element('span', 'authors__place', String(author.place));

	// Первая тройка — единственное место, где место само по себе что-то значит
	if (author.place <= 3) {
		place.classList.add('authors__place--top');
	}

	const name = element('span', 'authors__name', author.name);

	const packs = element('span', 'authors__packs');
	packs.append(element('b', null, formatNumber(author.packs)), document.createTextNode(
		` ${plural(author.packs, 'пак', 'пака', 'паков')}`));

	// Сколько паков автора статистика вообще знает: остальные считаются нулём игр,
	// и без этого числа ноль читался бы как «в них не играют»
	packs.title = author.known < author.packs
		? `Статистика знает ${author.known} из ${author.packs}: остальные она не находит по названию и автору`
		: 'Статистика знает все паки этого автора';

	const games = element('span', 'authors__games');
	games.append(element('b', null, formatNumber(author.games)), document.createTextNode(
		` ${plural(author.games, 'игра', 'игры', 'игр')}`));
	games.title = 'Сколько раз запускали паки этого автора — по данным статистики SIGame';

	// Игр в среднем за пак. Число это не про славу, а про попадание: три сотни
	// паков, которые открыли по разу, дают тот же итог, что и один разошедшийся,
	// — и в общем топе они стоят рядом, хотя это совсем разные авторы.
	const average = averageOf(author);
	const mean = element('span', 'authors__average');
	mean.append(element('b', null, formatAverage(average)), document.createTextNode(' за пак'));
	mean.title = author.packs > 0
		? `${formatNumber(author.games)} ${plural(author.games, 'игра', 'игры', 'игр')} на ${formatNumber(author.packs)} `
			+ `${plural(author.packs, 'пак', 'пака', 'паков')}. Паки, которых статистика не знает, считаются нулём`
		: 'Паков у автора нет';

	row.append(place, name, packs, games, mean);
	return row;
}

/** Регистр, ё и лишние пробелы при поиске по именам не важны. */
function normalize(text) {
	return (text ?? '').toLowerCase().replace(/ё/g, 'е').trim();
}

/**
 * Авторы, подходящие под строку поиска. Ищется вхождение, а не начало имени:
 * подписи бывают составные и с приставками, и «kot» должен находить «Big Kot».
 */
function matching() {
	const needle = normalize(state.search);

	if (!needle) {
		return ordering();
	}

	return ordering().filter(author => normalize(author.name).includes(needle));
}

function render() {
	const box = $('table');
	box.textContent = '';

	$('heading').textContent = '';
	$('heading').append(icon('trophy'), element('span', null,
		`Топ авторов паков ${SORT_NAMES[state.sort]} ${PERIOD_NAMES[state.period]}`));

	renderHint();

	if (data.authors.length === 0) {
		box.append(element('div', 'empty', 'За этот период паков не выкладывали.'));
		renderPager(0);
		return;
	}

	const found = matching();

	if (found.length === 0) {
		box.append(element('div', 'empty', 'Авторов с таким именем в топе нет.'));
		renderPager(0);
		return;
	}

	// Страница могла оказаться за концом списка: так бывает после поиска,
	// который оставил от пяти тысяч авторов десяток
	const pageCount = Math.max(1, Math.ceil(found.length / PAGE_SIZE));
	state.page = Math.min(Math.max(1, state.page), pageCount);

	const head = element('div', 'authors__row authors__row--head');
	head.append(
		element('span', 'authors__place', '#'),
		element('span', 'authors__name', 'Автор'),
		element('span', 'authors__packs', 'Паков'),
		element('span', 'authors__games', 'Игр'),
		element('span', 'authors__average', 'В среднем'),
	);

	// По какому столбцу список сейчас разложен — видно прямо в шапке: иначе
	// выбранный порядок остаётся только в списке над таблицей
	const sorted = { games: 'authors__games', average: 'authors__average', packs: 'authors__packs' }[state.sort];

	head.querySelector(`.${sorted}`)?.classList.add('authors__column--sorted');

	box.append(head);

	for (const author of found.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE)) {
		box.append(createRow(author));
	}

	renderPager(found.length);
}

/**
 * Кнопки страниц. Устроены так же, как в библиотеке: соседи, концы и многоточие
 * между ними, — но короче: перескакивать отсюда на сороковую страницу незачем,
 * для этого есть поиск по имени.
 */
function renderPager(total) {
	const pager = $('pager');
	pager.textContent = '';

	const pageCount = Math.ceil(total / PAGE_SIZE);

	if (pageCount <= 1) {
		return;
	}

	const addButton = (label, page, disabled, current) => {
		const button = element('button', null, label);
		button.type = 'button';
		button.disabled = !!disabled;

		if (current) {
			button.setAttribute('aria-current', 'true');
		}

		if (!disabled && !current) {
			button.addEventListener('click', () => {
				state.page = page;
				render();
				window.scrollTo({ top: 0, behavior: 'smooth' });
			});
		}

		pager.append(button);
	};

	addButton('‹', state.page - 1, state.page === 1);

	const pages = new Set([1, pageCount, state.page]);

	for (let offset = 1; offset <= 2; offset++) {
		pages.add(state.page - offset);
		pages.add(state.page + offset);
	}

	const visible = [...pages].filter(page => page >= 1 && page <= pageCount).sort((a, b) => a - b);
	let previous = 0;

	for (const page of visible) {
		if (page - previous > 1) {
			const gap = element('button', null, '…');
			gap.disabled = true;
			pager.append(gap);
		}

		addButton(String(page), page, false, page === state.page);
		previous = page;
	}

	addButton('›', state.page + 1, state.page === pageCount);
}

async function load() {
	data = await (await fetch(`/api/authors?period=${encodeURIComponent(state.period)}`)).json();
	ordered = null;
	render();
}

$('period').addEventListener('change', event => {
	state.period = event.target.value;
	state.page = 1;
	load();
});

// Порядок меняется без похода на сервер: список уже здесь, а сортировать его
// он всё равно умеет только одним способом — по числу игр
$('sort').addEventListener('change', event => {
	state.sort = event.target.value;
	state.page = 1;
	ordered = null;
	render();
});

// Поиск идёт по уже приехавшему списку, поэтому ждать здесь нечего: буква —
// и сразу выдача. Страница при этом сбрасывается на первую: искать на восьмой
// странице прежнего списка никто не собирался.
let searchTimer = null;

$('authorSearch').addEventListener('input', event => {
	const value = event.target.value;

	clearTimeout(searchTimer);

	// Полсотни миллисекунд — не задержка ради сервера, а защита от перерисовки
	// пяти тысяч строк на каждое нажатие клавиши
	searchTimer = setTimeout(() => {
		state.search = value;
		state.page = 1;
		render();
	}, 50);
});

// Шапка здесь та же, что и на всех остальных страницах сайта. Настройки ей нужны
// свои — счётчики и уголок входа, — а самому топу авторов они ни за чем,
// и ждать их списку незачем
initTopbar();

load();
