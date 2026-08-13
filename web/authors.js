// Топ авторов паков: у кого их играют больше всех.
//
// Считается по статистике SIGame — по числу запусков, а не по числу паков:
// десять паков, которые никто не открыл, значат меньше одного, сыгранного
// тысячу раз. Число паков стоит рядом, чтобы разница была видна.
//
// Что означает период — см. renderHint: окно подсчёта самих игр сервис
// статистики отдавать не умеет, и период отбирает паки, а не игры.

'use strict';

const state = { period: 'all' };

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

	$('periodHint').textContent = days
		? `Считаются паки, выложенные в обсуждение после ${periodStart(days)}, а игры у них — за всё время: `
			+ 'сколько раз пак запускали именно за период, сервис статистики не сообщает. '
			+ 'То есть это «чьи свежие паки играют больше всех», а не «кого больше играли этой весной».'
		: 'Считаются все паки автора и все их игры по данным статистики SIGame. '
			+ 'Копии одного и того же пака считаются за один.';
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

function render() {
	const box = $('table');
	box.textContent = '';

	$('heading').textContent = '';
	$('heading').append(icon('trophy'), element('span', null, `Топ авторов паков ${PERIOD_NAMES[state.period]}`));

	renderHint();

	if (data.authors.length === 0) {
		box.append(element('div', 'empty', 'За этот период паков не выкладывали.'));
		return;
	}

	const head = element('div', 'authors__row authors__row--head');
	head.append(
		element('span', 'authors__place', '#'),
		element('span', 'authors__name', 'Автор'),
		element('span', 'authors__packs', 'Паков'),
		element('span', 'authors__games', 'Игр'),
	);

	box.append(head);

	for (const author of data.authors) {
		box.append(createRow(author));
	}
}

async function load() {
	data = await (await fetch(`/api/authors?period=${encodeURIComponent(state.period)}`)).json();
	render();
}

$('period').addEventListener('change', event => {
	state.period = event.target.value;
	load();
});

load();
