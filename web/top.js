// Топ пакетов: десятка самых играемых за последние три месяца — отдельно
// в каждой категории.
//
// Зачем она есть. Всё это умеет и сама библиотека: сортировка «популярные
// за 3 месяца» плюс галочка типа пака в колонке слева. Но чтобы посмотреть
// семь категорий, там надо семь раз пройти один и тот же путь — открыть фильтры,
// снять прежний тип, отметить новый, — и ответа «что вообще сейчас играют»
// с одного взгляда не получается. Здесь он получается: ряд кнопок сверху,
// под ними десятка.
//
// Категорий семь, и они не повторяют список типов паков один в один: там их
// десять, и книги, комиксы с мангой набирают за три месяца по паку-двум —
// десятки из них не выйдет. Поэтому всё, что не попало в шесть основных,
// сведено в «Разное» (см. CATEGORIES).
//
// Свои паки страница не рисует: карточка тут та же самая, что в библиотеке
// и на странице пака (см. card.js).

'use strict';

/** Сколько паков в каждой категории. */
const TOP_SIZE = 10;

/**
 * Окно подсчёта. Ключ — это сортировка API (sort=popular_quarter), и period
 * там означает не «сколько игр за три месяца» (число игр сервис статистики
 * отдаёт только за всё время), а «паки, выложенные в обсуждение за три месяца,
 * самые играемые сверху». Разница важная, и о ней сказано подсказкой под
 * заголовком.
 */
const PERIOD_SORT = 'popular_quarter';
const PERIOD_DAYS = 91;

/**
 * Категории быстрого выбора.
 *
 * topics — то, что уходит в отбор API: ключи те же, что у типов паков
 * в библиотеке. Их у категории бывает несколько — «Разное» и есть тот случай:
 * туда собрано всё, чему своей вкладки не досталось, включая паки, которым
 * тип ещё не считали.
 *
 * Музыка стоит особняком и здесь, как везде: она отбирается не по ярлыку,
 * а по доле музыкальных вопросов, и аниме-пак с опенингами попадает и в свою
 * вкладку, и в музыкальную. Это не ошибка списка, а свойство самой музыки —
 * она отвечает на вопрос «как отгадывают», а не «о чём вопрос».
 */
const CATEGORIES = [
	{ key: 'mixed', name: 'Солянки', icon: 'mixed', topics: ['mixed'] },
	{ key: 'anime', name: 'Аниме-паки', icon: 'anime', topics: ['anime'] },
	{ key: 'games', name: 'Игропаки', icon: 'games', topics: ['games'] },
	{ key: 'movies', name: 'Кинопаки', icon: 'movies', topics: ['movies'] },
	{ key: 'cartoons', name: 'Мультпаки', icon: 'cartoons', topics: ['cartoons'] },
	{ key: 'music', name: 'Музпаки', icon: 'music', topics: ['music'] },
	{
		key: 'rest',
		name: 'Разное',
		icon: 'unknown',
		topics: ['books', 'comics', 'manga', 'unknown'],
		about: 'Всё, что не попало в остальные вкладки: книгапаки, комикс-паки, манга-паки '
			+ 'и паки, которым тип ещё не считали',
	},
];

const categoryOf = key => CATEGORIES.find(category => category.key === key) ?? CATEGORIES[0];

/** Какая вкладка открыта. Стоит в адресе, чтобы ссылкой на неё можно было делиться. */
let current = categoryOf(new URLSearchParams(window.location.search).get('c') ?? '');

/**
 * Уже показанные десятки. Вкладки переключают туда-сюда, а список за это время
 * не меняется: второй раз спрашивать сервер о том же самом незачем.
 */
const loaded = new Map();

/**
 * Нажали на автора, тип пака, тему или повтор прямо в карточке. Отбирать здесь
 * нечего — на странице десять паков одной категории, — поэтому вопрос «покажи
 * такие же» уводит в библиотеку, которая читает фильтры прямо из адреса
 * (см. readUrlState в app.js). Так же поступает и страница пака.
 */
function pickFilter(kind, value) {
	const names = { author: 'author', topic: 'topic', tag: 'tag', franchise: 'franchise', subject: 'subject' };
	window.location.href = `/?${names[kind]}=${encodeURIComponent(value)}`;
}

/** Отметки на этой странице ничего за пределами карточки не меняют. */
function onPlayedChange() {}
function onPlannedChange() {}

/** Уголок входа. Тот же, что на странице пака: пояснения здесь не к месту. */
function renderAccount() {
	const box = $('account');
	box.textContent = '';

	if (!facets.hasDiscord) {
		return;
	}

	if (!user) {
		const login = element('a', 'button button--discord', 'Войти через Discord');
		login.href = '/auth/discord';
		login.title = 'Оценки паков и личный чёрный список появляются после входа';
		box.append(login);
		return;
	}

	box.append(createAccountLink(user));

	const out = element('button', 'button button--ghost', 'Выйти');
	out.type = 'button';
	out.addEventListener('click', async () => {
		await fetch('/auth/logout', { method: 'POST' });
		window.location.reload();
	});

	box.append(out);
}

/** Начало периода: «за 3 месяца» — это паки, выложенные после этой даты. */
function periodStart() {
	return new Date(Date.now() - PERIOD_DAYS * 24 * 60 * 60 * 1000).toLocaleDateString('ru-RU');
}

function renderHint() {
	// Про период надо сказать прямо: «за 3 месяца» человек читает как «сколько
	// раз в них сыграли», а считается другое — из паков, выложенных за эти три
	// месяца, самые играемые. Число игр сервис статистики отдаёт только общее,
	// за всё время, и окна подсчёта у него нет.
	// «По десятке, если столько набралось» — не оговорка ради оговорки: за три
	// месяца мультпаков выкладывают пару штук, и короткий список там не недосмотр,
	// а весь список целиком.
	$('hint').textContent = `Паки, выложенные в обсуждение после ${periodStart()}, самые играемые сверху — `
		+ `по ${TOP_SIZE} в каждой категории, если столько набралось. Число игр общее, за всё время: `
		+ `окна подсчёта у статистики SIGame нет, и три месяца отбирают паки, а не игры.`
		+ (current.about ? ` ${current.about}.` : '');
}

function renderTabs() {
	const box = $('tabs');
	box.textContent = '';

	for (const category of CATEGORIES) {
		const chosen = category.key === current.key;
		const button = element('button', `level-toggle top-tab topic--${category.icon}`);
		button.type = 'button';
		button.setAttribute('aria-pressed', String(chosen));
		button.title = `Топ ${TOP_SIZE} за 3 месяца: ${category.name.toLowerCase()}`;

		button.append(topicIcon(category.icon, 'topic-icon'), element('span', 'label', category.name));

		button.addEventListener('click', () => {
			if (chosen) {
				return;
			}

			current = category;

			// Вкладка живёт в адресе: ссылкой на «Аниме-паки» можно поделиться,
			// а кнопка «назад» возвращает к прежней вкладке, а не уводит со страницы
			window.history.pushState({}, '', `/top?c=${category.key}`);

			renderTabs();
			renderHint();
			show();
		});

		box.append(button);
	}
}

/** Запрос десятки: та же выдача, что и в библиотеке, только отобранная и обрезанная. */
function buildQuery(category) {
	const query = new URLSearchParams({
		sort: PERIOD_SORT,
		dir: 'desc',
		page: '1',
		pageSize: String(TOP_SIZE),
		topic: category.topics.join(','),
		// Паки без оценки сложности из топа выбрасывать не за что: топ отвечает
		// на вопрос «что играют», а сложность считается по статистике и есть
		// далеко не у всех
		unrated: '1',
	});

	return query;
}

/**
 * Показать десятку выбранной категории. Уже показанную берём из памяти:
 * переключение вкладок туда-сюда не должно ходить на сервер за одним и тем же.
 */
async function show() {
	const category = current;
	const box = $('list');

	box.textContent = '';
	shownCards = [];

	if (!loaded.has(category.key)) {
		box.append(element('div', 'empty', 'Загрузка…'));

		const response = await fetch(`/api/packages?${buildQuery(category)}`);
		loaded.set(category.key, (await response.json()).packages ?? []);

		// Пока ходили на сервер, могли нажать другую вкладку: рисовать теперь
		// надо её, а не ту, за которой шли. Список при этом сохранён — вернутся
		// сюда, и он уже готов.
		if (category.key !== current.key) {
			return;
		}

		box.textContent = '';
	}

	const packs = loaded.get(category.key);

	if (packs.length === 0) {
		box.append(element('div', 'empty', 'За три месяца таких паков не выкладывали. '
			+ 'Загляните в библиотеку — там эта категория есть за всё время.'));
		return;
	}

	packs.forEach((pack, index) => {
		const item = element('div', 'top-item');
		const card = createCard(pack);

		// Место написано числом рядом с карточкой, а не только порядком в списке:
		// на широком экране десятка ложится в три столбца, и «третий сверху»
		// перестаёт значить «третий по играм»
		item.append(element('div', 'top-item__place', `№${index + 1}`), card);

		shownCards.push({ pack, card });
		box.append(item);
	});

	measureDescriptions();
}

// Кнопка «назад» возвращает к прежней вкладке: она же меняла адрес
window.addEventListener('popstate', () => {
	current = categoryOf(new URLSearchParams(window.location.search).get('c') ?? '');
	renderTabs();
	renderHint();
	show();
});

// Описания обрезаются по высоте, и мерить их надо заново, когда ширина
// карточки изменилась, — так же, как в библиотеке
let resizeTimer = null;

window.addEventListener('resize', () => {
	clearTimeout(resizeTimer);
	resizeTimer = setTimeout(measureDescriptions, 200);
});

async function start() {
	loadLocalMarks();

	// Обе ходки уходят разом: десятке настройки не нужны, чтобы быть запрошенной
	const packages = fetch(`/api/packages?${buildQuery(current)}`);

	facets = await (await fetch('/api/facets')).json();
	user = facets.user ?? null;

	renderAccount();
	renderTabs();
	renderHint();

	loaded.set(current.key, (await (await packages).json()).packages ?? []);
	show();
}

start();
