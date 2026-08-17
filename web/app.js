'use strict';

const state = {
	search: '',
	levels: new Set(),
	unrated: true,
	// Сыгранное спрятано с самого начала: библиотеку открывают, чтобы выбрать,
	// во что играть сегодня, а сыгранный пак на этот вопрос уже ответил. Найти
	// его можно соседней галочкой — «только сыгранные», — и весь список сыгранного
	// целиком лежит в профиле.
	//
	// Без входа отметки живут в самом браузере, база о них не знает и отобрать
	// по ним не может: там эта галочка гаснет и снимается (см. renderPlayedFilters).
	hidePlayed: true,
	onlyPlayed: false,
	// Отобранное на будущий вечер. Полный список — в профиле, а здесь по нему
	// можно искать теми же фильтрами, что и по всей библиотеке
	onlyPlanned: false,
	// Тем, типов пака и языков можно выбрать сразу несколько: подходит тот пак,
	// что попал хотя бы в один из выбранных
	tags: new Set(),
	topics: new Set(),
	languages: new Set(),
	franchise: '',
	// Дополнительный тип пака: пак целиком про одно — про Вархаммер, про футбол.
	// Отдельно от franchise нарочно: там «где эта франшиза встречается вообще»,
	// здесь «паки этого типа», и это разные списки (см. subjectPackShare).
	subject: '',
	author: '',
	sort: 'added',
	dir: 'desc',
	page: 1,
	pageSize: 24,
};

/**
 * Сколько паков каждой сложности в нынешней выборке. Приходит вместе с выдачей
 * и считается по тем же фильтрам: выбрав «Аниме», человек видит, сколько аниме-паков
 * лёгких, а сколько сложных, — раньше там стояли числа по всей базе, и после
 * нажатия оказывалось, что из восьми сотен «лёгких» осталось четырнадцать.
 */
let levelCounts = {};

// $, element, plural, formatNumber, formatSize, createLogo и createPlayLink живут в common.js,
// а значки — в icons.js: icon(), topicIcon() и iconText().
//
// Сама карточка пака — в card.js: её же показывает отдельная страница пака
// (/pack/…), и второго описания у неё быть не должно. Оттуда же приезжают facets,
// user, отметки «сыграно» и чёрный список — всё, что нужно и выдаче, и той странице.

const LEVEL_ORDER = [4, 3, 2, 1];

/**
 * Порядок типов пака в колонке фильтров. Солянка стоит первой не потому, что
 * она главная, а потому, что её больше всех: список читают сверху, и начинаться
 * он должен с того, во что упирается большинство паков. Дальше — тематические,
 * от самых частых, и «без разметки» в самом конце: это не тип, а его отсутствие.
 */
const TOPIC_ORDER = ['mixed', 'anime', 'manga', 'games', 'movies', 'cartoons', 'books', 'comics', 'music', 'sport', 'unknown'];

/** Сортировки по популярности за период: подпись и длина окна в днях. */
const PERIOD_NAMES = {
	popular_week: 'за неделю',
	popular_month: 'за месяц',
	popular_quarter: 'за 3 месяца',
	popular_half: 'за полгода',
	popular_year: 'за год',
};

const PERIOD_DAYS = {
	popular_week: 7,
	popular_month: 30,
	popular_quarter: 91,
	popular_half: 182,
	popular_year: 365,
};

/** Начало периода: «за год» — это паки, вышедшие после этой даты. */
function periodStart(days) {
	const date = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
	return date.toLocaleDateString('ru-RU');
}

/**
 * Нажали на автора, тип пака, тему или повтор прямо в карточке. Здесь, в самой
 * библиотеке, это меняет фильтры на месте и перезагружает одну только выдачу;
 * на отдельной странице пака та же карточка уводит ссылкой сюда (см. web/pack.js).
 */
function pickFilter(kind, value) {
	if (kind === 'author') {
		selectAuthor(value);
		return;
	}

	if (kind === 'topic') {
		// Клик по ярлыку — это «покажи только такие»: прежний набор типов
		// заменяется, а не дополняется. Набирать несколько удобнее галочками слева
		state.topics = new Set([value]);
		renderTopics();
	} else if (kind === 'tag') {
		state.tags.add(value);
		renderTags();
	} else if (kind === 'franchise') {
		state.franchise = value;
	} else if (kind === 'subject') {
		state.subject = value;
		renderSubjects();
	}

	state.page = 1;
	renderActiveFilters();
	load();
	window.scrollTo({ top: 0, behavior: 'smooth' });
}

/**
 * Отметку «сыграно» переключили на одной из карточек. Сама карточка к этому мигу
 * уже перерисована (см. card.js) — здесь остаётся то, что за её пределами: счётчик
 * в шапке и выдача, из которой отмеченный пак должен пропасть.
 */
function onPlayedChange(pack) {
	if (serverMarks()) {
		facets.played += pack.played ? 1 : -1;
	}

	renderTopbarCounters(facets);

	// Прятать сыгранное умеет только сервер: отбор идёт по базе, и местных
	// отметок он не видит. Пока их не перенесли, карточка просто остаётся
	// на месте отмеченной — это честнее, чем прятать её на одной странице
	// и показывать на следующей.
	if (serverMarks() && state.hidePlayed && pack.played) {
		load();
	}
}

/**
 * Пак отложили на будущее или передумали. Как и с «сыграно», сама карточка
 * к этому мигу уже перерисована — здесь остаётся счётчик в шапке.
 *
 * Выдача при этом не перезагружается, даже когда включено «только
 * запланированные»: пак, только что убранный из планов, исчез бы прямо
 * из-под руки, и человек не увидел бы даже, что именно пропало. Уйдёт он
 * при следующем обновлении страницы — так же, как спрятанное в чёрный список.
 */
function onPlannedChange(pack) {
	if (serverMarks()) {
		facets.planned = Math.max(0, (facets.planned ?? 0) + (pack.planned ? 1 : -1));
	}

	renderTopbarCounters(facets);
}

function buildQuery() {
	const query = new URLSearchParams({
		sort: state.sort,
		dir: state.dir,
		page: String(state.page),
		pageSize: String(state.pageSize),
	});

	if (state.search) {
		query.set('search', state.search);
	}

	if (state.levels.size > 0) {
		query.set('levels', [...state.levels].join(','));
	}

	// Выбранная сложность сама отвечает на вопрос про паки без оценки: их не показываем.
	// Иначе галочка, включённая по умолчанию, подмешивала бы их к любому уровню.
	if (state.unrated && state.levels.size === 0) {
		query.set('unrated', '1');
	}

	if (state.hidePlayed) {
		query.set('hidePlayed', '1');
	}

	if (state.onlyPlayed) {
		query.set('onlyPlayed', '1');
	}

	if (state.onlyPlanned) {
		query.set('onlyPlanned', '1');
	}

	if (state.tags.size > 0) {
		query.set('tag', [...state.tags].join(','));
	}

	if (state.topics.size > 0) {
		query.set('topic', [...state.topics].join(','));
	}

	if (state.languages.size > 0) {
		query.set('lang', [...state.languages].join(','));
	}

	if (state.franchise) {
		query.set('franchise', state.franchise);
	}

	if (state.subject) {
		query.set('subject', state.subject);
	}

	if (state.author) {
		query.set('author', state.author);
	}

	return query;
}

/**
 * Галочки «скрыть сыгранные» и «только сыгранные». Отбирает по ним база, а значит
 * работать они могут только с теми отметками, которые до базы доехали: пока входа
 * нет, отметки лежат в самом браузере, и сервер о них не знает.
 *
 * Поэтому без входа галочки гаснут, а подсказка говорит, чего им не хватает.
 * Работающими они при этом не притворяются — отметить сыгранным по-прежнему можно.
 */
function renderPlayedFilters() {
	const locked = !serverMarks();

	for (const id of ['hidePlayed', 'onlyPlayed', 'onlyPlanned']) {
		const input = $(id);
		input.disabled = locked;

		// Отбор снимается и с галочки, и из состояния: он мог приехать из адреса
		// (/?onlyPlanned=1 — ссылка из профиля), а работать ему всё равно нечем
		if (locked) {
			input.checked = false;
			state[id] = false;
		}

		const row = input.closest('.check');
		row.classList.toggle('check--disabled', locked);
		row.title = locked
			? 'Отбирает по отметкам база, а до входа они лежат в самом браузере. '
				+ 'Войдите через Discord — отметки переедут в учётную запись, и отбор заработает'
			: '';
	}
}

/**
 * Пока сложность не выбрана, галочка «показывать паки без оценки» решает, видно ли их.
 * Как только выбран хотя бы один уровень, вопрос отпадает сам собой: у пака без оценки
 * уровня нет, и попасть в выборку он не может. Галочка гаснет, чтобы не выглядела
 * работающей, — раньше она в этом случае молча подмешивала неоценённые паки обратно.
 */
function renderUnrated() {
	const locked = state.levels.size > 0;
	const input = $('unrated');

	input.disabled = locked;
	input.checked = locked ? false : state.unrated;
	$('unratedRow').classList.toggle('check--disabled', locked);
	$('unratedRow').title = locked ? 'Выбрана сложность — паки без оценки не показываются' : '';
}

/**
 * Сложности. У каждой две мишени, и они делают разное:
 *
 *   галочка — добавить сложность к уже выбранным (или убрать одну из них);
 *   сама строка — оставить только эту сложность, забыв остальные.
 *
 * Так чаще всего и хотят: посмотреть один уровень — одно нажатие, и не нужно
 * снимать по очереди то, что было отмечено раньше. Повторное нажатие на
 * единственную выбранную сложность снимает её вовсе и возвращает все паки.
 */
function renderLevels() {
	const container = $('levels');
	container.textContent = '';

	const apply = () => {
		state.page = 1;
		renderLevels();
		renderUnrated();
		renderActiveFilters();
		load();
	};

	// Числа считаются по остальным выбранным фильтрам: сама сложность из подсчёта
	// выброшена — иначе у выбранного уровня стояло бы его же число, а у соседних нули
	const narrowed = countActiveFilters() - state.levels.size > 0;

	for (const level of LEVEL_ORDER) {
		const info = facets.levelNames[level];
		const count = levelCounts[level] ?? 0;
		const chosen = state.levels.has(level);

		const row = element('div', 'level-row');

		const check = element('label', 'level-check');
		check.title = 'Отметить несколько сложностей сразу';

		const input = element('input');
		input.type = 'checkbox';
		input.checked = chosen;
		input.setAttribute('aria-label', `${info.name}: добавить к выбранным`);

		input.addEventListener('change', () => {
			if (input.checked) {
				state.levels.add(level);
			} else {
				state.levels.delete(level);
			}

			apply();
		});

		check.append(input);

		const button = element('button', `level-toggle level--${info.key}`);
		button.type = 'button';
		button.setAttribute('aria-pressed', String(chosen));
		// Абзаца с порогами под колонкой больше нет, и объяснение переехало сюда:
		// оно нужно ровно в тот миг, когда смотришь на конкретную сложность,
		// а не отдельной простынёй, которую читают один раз и потом листают мимо.
		button.title = (chosen && state.levels.size === 1
			? 'Показать паки всех сложностей'
			: 'Показать только эту сложность')
			+ (narrowed
				? `. Паков этой сложности среди отобранных: ${count}`
				: `. Всего таких паков в базе: ${count}`)
			+ `. Считается доля вопросов, на которые за столом решились ответить: `
			+ `больше ${facets.thresholds.easy}% — лёгкий, меньше ${facets.thresholds.hard}% — очень сложный. `
			+ `Оценка появляется от ${facets.minGames} игр и ${facets.minShown} показанных вопросов`;

		button.append(element('span', 'dot'), element('span', 'label', info.name), element('span', 'count', String(count)));

		button.addEventListener('click', () => {
			// Нажали на единственную выбранную — значит, ограничение больше не нужно
			if (chosen && state.levels.size === 1) {
				state.levels.clear();
			} else {
				state.levels.clear();
				state.levels.add(level);
			}

			apply();
		});

		row.append(check, button);
		container.append(row);
	}
}

function renderTopics() {
	const container = $('topics');
	container.textContent = '';

	// Порядок — по числу паков, от частых к редким. Раньше он был задан списком
	// раз и навсегда (солянка, аниме, манга, игры…), и выходило, что вверху колонки
	// стоял тип, которого в базе полторы сотни паков, а тысячи кинопаков искались
	// глазами в середине. Отбирают же типом, которого много: список сам должен
	// начинаться с того, ради чего в него смотрят.
	//
	// Порядок из TOPIC_ORDER остаётся запасным — им разнимаются равные числа,
	// чтобы колонка не переставлялась сама собой при одинаковых счётчиках.
	const order = TOPIC_ORDER
		.map((key, index) => ({ key, index, count: facets.topics[key] ?? 0 }))
		.filter(item => item.count > 0 || state.topics.has(item.key))
		.sort((a, b) => b.count - a.count || a.index - b.index);

	for (const { key, count } of order) {
		const info = topicInfo(key);
		const button = element('button', `level-toggle topic--${key}`);
		button.type = 'button';
		button.setAttribute('aria-pressed', String(state.topics.has(key)));

		// То же, что стояло абзацем под колонкой: отметить можно сколько угодно,
		// а сам тип считается по долям тем. Здесь это читается тогда, когда нужно.
		//
		// Название берётся packName, а не name: в колонке стоит вопрос «какого
		// типа пак», и отвечать на него надо «Аниме-пак», а не «Аниме» — слово
		// «Аниме» называет тематику вопросов, и им же подписан кусок полоски долей.
		button.title = `${info.packName}: паков ${count}. Можно отметить несколько типов сразу. `
			+ `Тип даётся паку, когда одна тематика занимает больше `
			+ `${Math.round(facets.topicThreshold * 100)}% вопросов, иначе это солянка`;

		button.append(
			topicIcon(key, 'topic-icon'),
			element('span', 'label', info.packName),
			element('span', 'count', String(count)),
		);

		button.addEventListener('click', () => {
			if (state.topics.has(key)) {
				state.topics.delete(key);
			} else {
				state.topics.add(key);
			}

			state.page = 1;
			renderTopics();
			renderActiveFilters();
			load();
		});

		container.append(button);
	}

	if (container.children.length === 0) {
		container.append(element('p', 'hint', 'Тематики ещё не размечены. Запустите «Обновить базу» с ключом Gemini.'));
	}
}

/**
 * Дополнительные типы паков: те, которых в пяти основных быть не может.
 *
 * Пять тематик отвечают на вопрос «о чём вопросы», и на пак про футбол ответа
 * у них нет: спорт живёт в «прочем», ни одна доля порога не берёт, и пак числится
 * солянкой. Пак по Вархаммеру по ним — просто «игропак», каких сотни. Тип здесь
 * даёт предмет, названный моделью у каждой темы (тот самый, по которому считаются
 * повторы): если один предмет занял больше половины вопросов, пак — про него.
 *
 * Выбрать можно только один: это не «покажи всё, где встречается Вархаммер»
 * (для этого есть повторы в самой карточке), а «покажи паки вот этого типа».
 */
function renderSubjects() {
	const container = $('subjects');
	const filter = normalize($('subjectSearch').value);
	container.textContent = '';

	// Ищется и по названию, и по его латинскому ключу: названия предметов в базе
	// почти сплошь русские, а набирают их как придётся — «dota», «naruto». Ключ
	// считает сервер (см. src/subject.js), он же без номера части, поэтому «dota»
	// находит и «Доту», и «Доту 2» — то есть один и тот же тип пака.
	const subjects = (facets.subjects ?? []).filter(item => !filter
		|| normalize(item.name).includes(filter)
		|| (item.key ?? '').includes(filter));

	// Выбранный тип показываем всегда, даже если он не попал ни в список
	// (тот короткий), ни под поиск: иначе снять его было бы нечем
	const chosen = state.subject && !subjects.some(item => item.name === state.subject)
		? [{ name: state.subject, count: null }]
		: [];

	for (const item of [...chosen, ...subjects]) {
		const picked = state.subject === item.name;
		const button = element('button', 'level-toggle');
		button.type = 'button';
		button.setAttribute('aria-pressed', String(picked));

		button.title = picked
			? 'Показать паки любых типов'
			: `Паки, которые целиком про одно: «${item.name}» занимает у них `
				+ `не меньше ${Math.round(facets.subjectPackShare * 100)}% вопросов`;

		button.append(
			icon('target', 'topic-icon'),
			element('span', 'label', item.name),
			// У выбранного вручную типа числа нет: список коротких, и считать его
			// отдельным запросом ради одной строки не за что
			element('span', 'count', item.count === null ? '·' : String(item.count)),
		);

		button.addEventListener('click', () => {
			state.subject = picked ? '' : item.name;
			state.page = 1;
			renderSubjects();
			renderActiveFilters();
			load();
		});

		container.append(button);
	}

	if (container.children.length === 0) {
		container.append(element('p', 'hint', filter
			? 'Ничего не нашлось.'
			: 'Появятся, когда паки разметит Gemini: тип берётся из предмета тем.'));
	}
}

/**
 * Язык пака — тот, что записан внутри файла. Список короткий (обычно русский,
 * английский и «без указания»), поэтому это такие же переключатели, как у
 * тематик, а не список с поиском: выбрать можно сколько угодно.
 */
function renderLanguages() {
	const container = $('languages');
	container.textContent = '';

	for (const language of facets.languages ?? []) {
		const button = element('button', 'level-toggle');
		button.type = 'button';
		button.setAttribute('aria-pressed', String(state.languages.has(language.key)));
		button.append(
			icon('globe', 'topic-icon'),
			element('span', 'label', language.name),
			element('span', 'count', String(language.count)),
		);

		button.title = language.key === 'unknown'
			? 'В файле пака язык не указан. Чаще всего такие паки русские, но обещать этого нельзя'
			: `Паки, у которых внутри файла указан этот язык (${language.key})`;

		button.addEventListener('click', () => {
			if (state.languages.has(language.key)) {
				state.languages.delete(language.key);
			} else {
				state.languages.add(language.key);
			}

			state.page = 1;
			renderLanguages();
			renderActiveFilters();
			load();
		});

		container.append(button);
	}

	if (container.children.length === 0) {
		container.append(element('p', 'hint', 'Языки появятся, когда паки будут разобраны.'));
	}
}

/**
 * Подпись под сортировкой. «Самые популярные за год» — это паки, выложенные
 * в обсуждение за последний год, от самых играемых: датой считается время
 * сообщения ВК, из которого взят файл.
 */
function renderSortHint() {
	const hint = $('sortHint');
	const days = PERIOD_DAYS[state.sort];

	// У сортировки по умолчанию подписи нет: «Сначала новые» написано в самом
	// списке, а объяснение, что новизна считается по времени сообщения ВК,
	// а не по порядку попадания в базу, стояло над выдачей всегда и читалось
	// как шапка страницы
	if (state.sort === 'added') {
		hint.textContent = '';
		return;
	}

	// «По совпадению с запросом» без самого запроса не сортирует ничего, и об этом
	// честнее сказать, чем оставить человека гадать, почему список не шелохнулся
	if (state.sort === 'relevance') {
		hint.textContent = state.search
			? 'Сначала паки, которые так и называются, потом те, у кого запрос в начале названия, '
				+ 'и только потом найденные по описанию, темам или тексту сообщения. '
				+ 'Внутри каждой ступени — сначала новые.'
			: 'Сортировать по совпадению не с чем: строка поиска пуста. Паки идут как обычно — сначала новые.';
		return;
	}

	if (state.sort === 'rating') {
		hint.textContent = `Средняя оценка игроков по десятибалльной шкале. `
			+ `Паки, которых оценили меньше ${facets.minRatings} раз, идут в конце: `
			+ `по двум-трём оценкам среднее случайно, и балл у них не показывается.`;
		return;
	}

	if (!days) {
		hint.textContent = '';
		return;
	}

	const undated = facets.total - facets.datedPackages;
	const skipped = undated > 0
		? ` Паков с неразобранной датой сообщения в подборку не попадает: ${undated}.`
		: '';

	hint.textContent = `Паки, выложенные в обсуждение после ${periodStart(days)}, самые играемые сверху. `
		+ `Считается по дате сообщения ВК, а не по дате внутри файла.${skipped}`;
}

/**
 * Тем в базе за сотню, поэтому это не выпадающий список, а список галочек
 * с поиском: выбрать можно сколько угодно. Выбранные всегда наверху — иначе
 * отмеченная тема уезжает из виду, стоит начать искать следующую.
 */
function renderTags() {
	const container = $('tags');
	const filter = normalize($('tagSearch').value);
	container.textContent = '';

	const matching = facets.tags.filter(tag => !filter || normalize(tag.name).includes(filter));
	const chosen = matching.filter(tag => state.tags.has(tag.name));
	const rest = matching.filter(tag => !state.tags.has(tag.name));
	const visible = [...chosen, ...rest.slice(0, 60)];

	for (const tag of visible) {
		const row = element('label', 'checklist__row');
		const input = element('input');
		input.type = 'checkbox';
		input.checked = state.tags.has(tag.name);

		input.addEventListener('change', () => {
			if (input.checked) {
				state.tags.add(tag.name);
			} else {
				state.tags.delete(tag.name);
			}

			state.page = 1;
			renderTags();
			renderActiveFilters();
			load();
		});

		row.append(input, element('span', 'checklist__name', tag.name), element('span', 'count', String(tag.count)));
		container.append(row);
	}

	if (visible.length === 0) {
		container.append(element('p', 'hint', 'Таких тем нет.'));
	} else if (rest.length > 60) {
		container.append(element('p', 'hint', `Показаны первые 60 из ${matching.length}. Уточните поиск.`));
	}
}

/** Регистр, ё и пробелы при поиске по темам не важны. */
function normalize(text) {
	return (text ?? '').toLowerCase().replace(/ё/g, 'е').trim();
}

// Уголок входа и счётчики шапки живут в common.js: шапка одна на весь сайт,
// и наполняется она везде одинаково (см. renderTopbar).

/** Плашки поверх выдачи: показывают, что список сужен, и снимают фильтр по клику. */
function renderActiveFilters() {
	const box = $('activeFilters');
	box.textContent = '';

	const add = (label, clear) => {
		const chip = element('button', 'filter-chip');
		chip.type = 'button';
		chip.append(element('span', null, label), element('span', 'filter-chip__x', '✕'));
		chip.addEventListener('click', () => {
			clear();
			state.page = 1;
			renderLevels();
			renderUnrated();
			renderTopics();
			renderSubjects();
			renderLanguages();
			renderTags();
			renderActiveFilters();
			load();
		});
		box.append(chip);
	};

	if (state.author) {
		add(`Автор: ${state.author}`, () => { state.author = ''; });
	}

	for (const level of LEVEL_ORDER) {
		if (state.levels.has(level)) {
			add(`Сложность: ${facets.levelNames[level].name}`, () => state.levels.delete(level));
		}
	}

	for (const topic of state.topics) {
		add(topicInfo(topic).packName, () => state.topics.delete(topic));
	}

	for (const key of state.languages) {
		const language = (facets.languages ?? []).find(item => item.key === key);
		add(`Язык: ${language?.name ?? key}`, () => state.languages.delete(key));
	}

	for (const tag of state.tags) {
		add(`Тема: ${tag}`, () => state.tags.delete(tag));
	}

	if (state.subject) {
		add(`Пак про одно: ${state.subject}`, () => { state.subject = ''; });
	}

	// «Предмет», а не «франшиза»: с тех пор как модель называет предмет и у тем
	// категории «прочее», сюда попадают и футбол, и Вторая мировая война
	if (state.franchise) {
		add(`Предмет: ${state.franchise}`, () => { state.franchise = ''; });
	}

	// Кнопка «Фильтры» показывает их число: на узком экране сама колонка свёрнута,
	// и по одним плашкам поверх выдачи всего набора не видно
	renderFiltersToggle();

	// Автора могли выбрать или снять только что — ссылка на обновление целится
	// туда же, куда смотрит выдача
	aimUpdateLink();
}

/**
 * Сколько фильтров сейчас сужают выдачу. Число висит на кнопке «Фильтры»:
 * на узком экране колонка свёрнута, и без него было бы не понять, почему паков
 * вдруг стало вдвое меньше.
 *
 * Считается при этом не всё выставленное, а всё отличающееся от того, как
 * библиотека открывается сама: галочки «показывать паки без оценки» и «скрыть
 * сыгранные» стоят с самого начала, и числом «2» на кнопке при первом же открытии
 * страницы это сообщать незачем. Зато снятая галочка — как раз отличие, и его
 * видно.
 */
function countActiveFilters() {
	return state.levels.size
		+ state.topics.size
		+ state.languages.size
		+ state.tags.size
		+ (state.franchise ? 1 : 0)
		+ (state.subject ? 1 : 0)
		+ (state.author ? 1 : 0)
		+ (state.hidePlayed || state.onlyPlayed || !serverMarks() ? 0 : 1)
		+ (state.onlyPlayed ? 1 : 0)
		+ (state.onlyPlanned ? 1 : 0)
		+ (state.unrated || state.levels.size > 0 ? 0 : 1);
}

function renderFiltersToggle() {
	const count = countActiveFilters();
	const badge = $('filtersCount');

	badge.hidden = count === 0;
	badge.textContent = String(count);
}

function selectAuthor(author) {
	state.author = author;
	state.page = 1;
	renderActiveFilters();
	load();
	window.scrollTo({ top: 0, behavior: 'smooth' });
}

/** Кнопки страниц под выдачей. Сами кнопки — общие для всего сайта (см. common.js). */
function renderPager(total) {
	renderPages($('pager'), {
		page: state.page,
		pageSize: state.pageSize,
		total,
		onGo: page => {
			state.page = page;
			load();
		},
	});
}

/**
 * Выдача. Обычно сама и спрашивает её у сервера, но при первом открытии страницы
 * запрос уже летит — его начинает start() одновременно с настройками, не дожидаясь
 * ответа. Раньше эти два обращения шли друг за другом: сначала /api/facets,
 * и только на его ответе — /api/packages. Списку настройки не нужны, чтобы быть
 * запрошенным, и лишнее ожидание целой ходки до сервера доставалось каждому,
 * кто открывал сайт.
 *
 * @param {Promise<Response>|null} started уже начатый запрос выдачи
 */
async function load(started = null) {
	const grid = $('grid');
	const response = await (started ?? fetch(`/api/packages?${buildQuery()}`));
	const data = await response.json();

	grid.textContent = '';
	shownCards = [];
	renderActiveFilters();

	// Числа сложностей считаются по остальным фильтрам и приходят вместе с выдачей
	levelCounts = data.levels ?? {};
	renderLevels();

	if (data.packages.length === 0) {
		grid.append(element('div', 'empty', 'Ничего не нашлось. Попробуйте ослабить фильтры.'));
		$('resultInfo').textContent = 'Найдено: 0';
		renderPager(0);
		return;
	}

	for (const pack of data.packages) {
		const card = createCard(pack);
		shownCards.push({ pack, card });
		grid.append(card);
	}

	measureDescriptions();

	const from = (data.page - 1) * data.pageSize + 1;
	const to = from + data.packages.length - 1;
	$('resultInfo').textContent = `Показаны ${from}–${to} из ${data.total}`;

	renderPager(data.total);
}

/**
 * Начать поиск тем, что набрано в поле. Зовётся по нажатию «Найти» и по Enter,
 * а не на каждую букву: см. форму поиска в index.html.
 *
 * Новый поиск сам переключает сортировку на «по совпадению с запросом» — но
 * только начатый с пустого места. Выбрал человек «по числу вопросов» и уточнил
 * запрос — сортировка остаётся его: переключать её под руками на каждом нажатии
 * значило бы спорить с только что сделанным выбором. Опустевшее поле возвращает
 * сортировку обратно к «сначала новые»: сортировать по запросу, которого нет,
 * не по чему.
 */
function submitSearch() {
	const text = $('search').value.trim();

	if (text === state.search) {
		return;
	}

	const started = text !== '' && state.search === '';

	state.search = text;

	if (started) {
		state.sort = 'relevance';
	} else if (text === '' && state.sort === 'relevance') {
		state.sort = 'added';
	}

	$('sort').value = state.sort;
	renderSortDirection();
	renderSortHint();

	state.page = 1;
	load();
}

/**
 * Порядок «по возрастанию/по убыванию» у сортировки по совпадению не спрашивают:
 * снизу там то, что подошло меньше всего, и показывать это первым незачем.
 */
function renderSortDirection() {
	$('dir').disabled = state.sort === 'relevance';
}

function bind() {
	$('searchBox').addEventListener('submit', event => {
		event.preventDefault();
		submitSearch();
	});

	// Крестик внутри поля (type="search") очищает его молча, без Enter, — и поиск
	// после этого сбрасывается сам: оставлять выдачу отобранной по запросу,
	// которого в поле уже нет, значит врать про неё
	$('search').addEventListener('search', () => {
		if ($('search').value.trim() === '') {
			submitSearch();
		}
	});

	$('unrated').addEventListener('change', event => {
		state.unrated = event.target.checked;
		state.page = 1;
		load();
	});

	$('hidePlayed').addEventListener('change', event => {
		state.hidePlayed = event.target.checked;

		if (state.hidePlayed) {
			state.onlyPlayed = false;
			$('onlyPlayed').checked = false;
		}

		state.page = 1;
		load();
	});

	$('onlyPlayed').addEventListener('change', event => {
		state.onlyPlayed = event.target.checked;

		if (state.onlyPlayed) {
			state.hidePlayed = false;
			$('hidePlayed').checked = false;
		}

		state.page = 1;
		load();
	});

	// «Только запланированные» ни с чем не спорит: отложить можно и сыгранный пак,
	// и неоценённый, — поэтому соседние галочки эта не снимает
	$('onlyPlanned').addEventListener('change', event => {
		state.onlyPlanned = event.target.checked;
		state.page = 1;
		load();
	});

	let tagTimer = null;

	$('tagSearch').addEventListener('input', () => {
		clearTimeout(tagTimer);
		tagTimer = setTimeout(renderTags, 150);
	});

	let subjectTimer = null;

	$('subjectSearch').addEventListener('input', () => {
		clearTimeout(subjectTimer);
		subjectTimer = setTimeout(renderSubjects, 150);
	});

	$('sort').addEventListener('change', event => {
		state.sort = event.target.value;
		state.page = 1;
		renderSortDirection();
		renderSortHint();
		load();
	});

	$('dir').addEventListener('change', event => {
		state.dir = event.target.value;
		state.page = 1;
		load();
	});

	// Колонка фильтров на узком экране свёрнута: она встаёт над выдачей и занимает
	// собой пару экранов, а листать до первого пака никто не станет. На широком
	// экране кнопки не видно вовсе, и класс на неё ни на что не влияет.
	$('filtersToggle').addEventListener('click', () => {
		const opened = $('filters').classList.toggle('filters--open');
		$('filtersToggle').setAttribute('aria-expanded', String(opened));
	});

	// Меню чёрного списка закрывается щелчком мимо него, но подписывается на это
	// не библиотека, а сама карточка (см. card.js): меню принадлежит ей, и нужно
	// оно на любой странице, где карточки есть.

	// Ширина колонки меняет число строк в описаниях: где-то кнопка «Показать
	// полностью» становится не нужна, а где-то, наоборот, появляется
	let resizeTimer = null;

	window.addEventListener('resize', () => {
		clearTimeout(resizeTimer);
		resizeTimer = setTimeout(measureDescriptions, 200);
	});

	$('reset').addEventListener('click', resetFilters);
}

function resetFilters() {
	state.search = '';
	state.levels.clear();
	state.unrated = true;
	// «Сбросить фильтры» возвращает к тому, как библиотека открывается, — а
	// открывается она без сыгранного
	state.hidePlayed = true;
	state.onlyPlayed = false;
	state.onlyPlanned = false;
	state.tags.clear();
	state.topics.clear();
	state.languages.clear();
	state.franchise = '';
	state.subject = '';
	state.author = '';
	state.sort = 'added';
	state.dir = 'desc';
	state.page = 1;

	$('search').value = '';
	$('hidePlayed').checked = true;
	$('onlyPlayed').checked = false;
	$('onlyPlanned').checked = false;
	$('tagSearch').value = '';
	$('subjectSearch').value = '';
	$('sort').value = 'added';
	$('dir').value = 'desc';

	renderLevels();
	renderUnrated();
	renderPlayedFilters();
	renderTopics();
	renderSubjects();
	renderLanguages();
	renderTags();
	renderActiveFilters();
	renderSortDirection();
	renderSortHint();
	load();
}

/**
 * Начальные фильтры из адреса страницы. Ими пользуется профиль: оттуда ведут
 * ссылки вида /?levels=4 и /?author=…, и открываться они должны сразу на нужной
 * выборке. Имена совпадают с теми, что уходят в /api/packages, — второго словаря
 * для одного и того же набора фильтров заводить не за чем.
 */
function readUrlState() {
	const query = new URLSearchParams(window.location.search);
	const list = name => (query.get(name) ?? '').split(',').map(v => v.trim()).filter(Boolean);

	state.search = query.get('search') ?? '';

	for (const level of list('levels').map(Number).filter(Number.isFinite)) {
		state.levels.add(level);
	}

	for (const topic of list('topic')) {
		state.topics.add(topic);
	}

	for (const language of list('lang')) {
		state.languages.add(language);
	}

	for (const tag of list('tag')) {
		state.tags.add(tag);
	}

	state.franchise = query.get('franchise') ?? '';
	state.subject = query.get('subject') ?? '';
	state.author = query.get('author') ?? '';

	// Из профиля ведёт ссылка «показать запланированное в библиотеке»: там список
	// целиком, а здесь по нему можно искать теми же фильтрами, что и по всей базе
	state.onlyPlanned = query.get('onlyPlanned') === '1';
	state.onlyPlayed = query.get('onlyPlayed') === '1';

	// Сыгранное спрятано само собой, и снять это можно только адресом: /?hidePlayed=0
	// стоит в ссылках профиля, которые ведут в библиотеку как раз к сыгранному.
	// «Только сыгранные» снимает его и без всякой приписки: вместе эти два отбора
	// не оставляют ни одного пака.
	state.hidePlayed = !state.onlyPlayed && query.get('hidePlayed') !== '0';

	// Сортировка из адреса сильнее: ссылку с ней прислали нарочно. А вот адрес
	// с одним только поиском (/?search=…) открывается так же, как открылся бы
	// поиск, набранный руками, — сначала самое подходящее
	if (query.get('sort')) {
		state.sort = query.get('sort');
	} else if (state.search) {
		state.sort = 'relevance';
	}

	$('search').value = state.search;
	$('sort').value = state.sort;
	renderSortDirection();
	$('onlyPlanned').checked = state.onlyPlanned;
	$('onlyPlayed').checked = state.onlyPlayed;
	$('hidePlayed').checked = state.hidePlayed;
}

/**
 * «Обновить базу» с уже названным автором, когда выдача отобрана по нему.
 *
 * Обновлять базу целиком ради одного человека незачем: паков у автора десяток,
 * а в базе их тысячи. Поэтому ссылка ведёт на ту же страницу обновления, но
 * с заполненным полем «Авторы» — там останется нажать «Запустить», посмотрев,
 * что именно отмечено (см. web/update.js). Автор не выбран — ссылка обычная.
 */
function aimUpdateLink() {
	const link = $('updateLink');

	if (!link) {
		return;
	}

	link.href = state.author ? `/update?authors=${encodeURIComponent(state.author)}` : '/update';
	link.title = state.author ? `Обновить паки автора «${state.author}»` : '';
	link.textContent = state.author ? 'Обновить паки автора' : 'Обновить базу';
}

// Кнопки выкладки здесь больше нет. Она стояла в библиотеке ради решения
// «уезжать этому наверх или нет» — решения, которого не стало: база одна,
// и всё, что дописало обновление, тем же запуском оказывается на сайте
// (см. src/updater.js). Повтор после сорвавшейся отправки остался на странице
// обновления, где видно, что именно не доехало.

async function start() {
	// Фильтры из адреса читаются до всякой сети: они берутся из самой ссылки,
	// и без них нельзя составить запрос выдачи. Отметки, сделанные до входа,
	// лежат там же, где и фильтры, — под рукой, и спрашивать о них некого.
	readUrlState();
	loadLocalMarks();

	// Оба обращения к серверу уходят разом. Выдача не зависит от настроек —
	// ждать их ответа, чтобы только начать спрашивать паки, значило дарить
	// каждому открытию страницы лишнюю ходку до сервера.
	let packages = fetch(`/api/packages?${buildQuery()}`);

	facets = await (await fetch('/api/facets')).json();
	user = facets.user ?? null;

	// Вход мог не состояться — Discord вернул человека с пояснением в адресе.
	// Сообщение показываем один раз и убираем из адреса, чтобы оно не всплывало
	// при каждом обновлении страницы.
	const loginError = new URLSearchParams(window.location.search).get('login');

	if (loginError) {
		alert(loginError);
		const clean = new URL(window.location.href);
		clean.searchParams.delete('login');
		window.history.replaceState({}, '', clean);
	}

	// Пояснений под фильтрами больше нет: колонка объясняла сама себя абзацами,
	// которые читают один раз, а место они занимали при каждом открытии. Всё, что
	// в них стояло, осталось в подсказках при наведении — там, где оно и нужно:
	// на самих уровнях сложности и ярлыках тематик.

	// Вход состоялся, а в браузере ещё лежат отметки, сделанные до него: самое
	// время им переехать. Делается это до выдачи нарочно — иначе первая же
	// страница показала бы паки неотмеченными, и человек решил бы, что отметки
	// пропали при входе.
	if (serverMarks() && localMarks() > 0) {
		await uploadLocalMarks();

		// Настройки и выдачу спрашиваем заново: те ответы уехали с сервера до
		// переезда отметок, и паки в них ещё не отмечены
		packages = fetch(`/api/packages?${buildQuery()}`);
		facets = await (await fetch('/api/facets')).json();
	}

	// Шапка тут та же, что и на всех остальных страницах, и наполняется она общим
	// кодом (см. renderTopbar в common.js). Своё в ней ровно одно: «Обновить базу»
	// целится в выбранного автора, когда выдача отобрана по нему
	renderTopbar(facets);
	aimUpdateLink();

	renderLevels();
	renderUnrated();
	renderPlayedFilters();
	renderTopics();
	renderSubjects();
	renderLanguages();
	renderTags();
	renderSortHint();
	bind();
	await load(packages);
}

start();
