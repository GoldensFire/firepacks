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
const state = { period: 'all', page: 1, search: '' };

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

	$('periodHint').textContent = all + (days
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

	const average = author.packs > 0 ? Math.round(author.games / author.packs) : 0;
	games.title = `В среднем ${formatNumber(average)} ${plural(average, 'игра', 'игры', 'игр')} на пак`;

	row.append(place, name, packs, games);
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
		return data.authors;
	}

	return data.authors.filter(author => normalize(author.name).includes(needle));
}

function render() {
	const box = $('table');
	box.textContent = '';

	$('heading').textContent = '';
	$('heading').append(icon('trophy'), element('span', null, `Топ авторов паков ${PERIOD_NAMES[state.period]}`));

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
	);

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
	render();
}

$('period').addEventListener('change', event => {
	state.period = event.target.value;
	state.page = 1;
	load();
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

load();
