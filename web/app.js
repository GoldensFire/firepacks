'use strict';

const state = {
	search: '',
	levels: new Set(),
	unrated: true,
	hidePlayed: false,
	onlyPlayed: false,
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

let facets = null;

/**
 * Сколько паков каждой сложности в нынешней выборке. Приходит вместе с выдачей
 * и считается по тем же фильтрам: выбрав «Аниме», человек видит, сколько аниме-паков
 * лёгких, а сколько сложных, — раньше там стояли числа по всей базе, и после
 * нажатия оказывалось, что из восьми сотен «лёгких» осталось четырнадцать.
 */
let levelCounts = {};

/** Кто вошёл. Пока null — оценивать и прятать нельзя, остальное работает. */
let user = null;

// $, element, plural, formatNumber, formatSize, createLogo и createPlayLink живут в common.js,
// а значки — в icons.js: icon(), topicIcon() и iconText()

const LEVEL_ORDER = [4, 3, 2, 1];

/**
 * Порядок типов пака в колонке фильтров. Солянка стоит первой не потому, что
 * она главная, а потому, что её больше всех: список читают сверху, и начинаться
 * он должен с того, во что упирается большинство паков. Дальше — тематические,
 * от самых частых, и «без разметки» в самом конце: это не тип, а его отсутствие.
 */
const TOPIC_ORDER = ['mixed', 'anime', 'games', 'movies', 'cartoons', 'music', 'unknown'];

/** Категории, которые делят вопросы между собой: их доли складываются в сотню. */
const SHARE_ORDER = ['anime', 'games', 'movies', 'cartoons', 'other'];

/**
 * Из чего сделаны вопросы. Считается разбором самого файла (см. siq.js), и здесь
 * это вторая полоска под названием: она тоже полна ровно на сотню.
 */
const CONTENT_ORDER = ['text', 'image', 'audio', 'video', 'html'];

const CONTENT_NAMES = {
	text: 'Текст',
	image: 'Картинки',
	audio: 'Музыка и звук',
	video: 'Видео',
	html: 'HTML',
};

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

/** Ярлыки, которых нет в TOPICS: их считает не модель, а порог. */
const EXTRA_TOPICS = {
	mixed: { name: 'Солянка', packName: 'Солянка' },
	unknown: { name: 'Без разметки', packName: 'Без разметки' },
};

const topicInfo = key => facets.topicNames[key] ?? EXTRA_TOPICS[key] ?? { name: key, packName: key };

/** Как называется вид спецвопроса. Имена приходят с сервера вместе с остальными настройками. */
const specialName = key => facets.specialNames?.[key] ?? key;

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

	for (const key of TOPIC_ORDER) {
		const count = facets.topics[key] ?? 0;

		if (count === 0 && !state.topics.has(key)) {
			continue;
		}

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

	const subjects = (facets.subjects ?? []).filter(item => !filter || normalize(item.name).includes(filter));

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

/**
 * Уголок входа. Пока ключи Discord не заведены, вместо кнопки стоит пояснение:
 * кнопка, ведущая в «вход не настроен», хуже её отсутствия, но и молчание
 * оставляло сайт без ответа на вопрос «почему я не могу поставить оценку».
 */
function renderAccount() {
	const box = $('account');
	box.textContent = '';

	if (!facets.hasDiscord) {
		const note = element('span', 'account__note', 'Вход не настроен');
		note.title = 'Оценки паков появляются после входа через Discord (чёрный список работает и без него). '
			+ 'Чтобы его включить, заведите приложение на discord.com/developers/applications '
			+ 'и положите его ключи в data/discord-client-id.txt и data/discord-client-secret.txt — '
			+ 'подробности в README, раздел «Вход через Discord»';
		box.append(note);
		return;
	}

	if (!user) {
		const login = element('a', 'button button--discord', 'Войти через Discord');
		login.href = '/auth/discord';
		login.title = 'Оценки паков и личный чёрный список появляются после входа';
		box.append(login);
		return;
	}

	if (user.avatar) {
		const avatar = element('img', 'account__avatar');
		avatar.src = user.avatar;
		avatar.alt = '';
		avatar.width = 24;
		avatar.height = 24;
		box.append(avatar);
	}

	box.append(element('span', 'account__name', user.name));

	const out = element('button', 'button button--ghost', 'Выйти');
	out.type = 'button';
	out.addEventListener('click', async () => {
		await fetch('/auth/logout', { method: 'POST' });
		window.location.reload();
	});

	box.append(out);
}

/**
 * Можно ли прятать паки прямо сейчас. Вошедшему — всегда, а без входа только
 * на своей машине: там чёрный список принадлежит установке, как и отметки
 * «сыграно» (сервер говорит об этом в facets.localBlacklist).
 */
const canHide = () => Boolean(user) || facets?.localBlacklist === true;

/**
 * Можно ли отмечать паки сыгранными. Признак тот же самый, и это не лень:
 * вопрос у обоих один — есть ли у отметки хозяин. Дома хозяин — сама установка,
 * и отмечать можно без входа; на общем сайте хозяина без входа нет, и отметка
 * одного человека зажигалась бы у всех сразу.
 */
const canMark = canHide;

/**
 * Карточки, которые сейчас на странице: пак и его узел. Нужны чёрному списку —
 * спрятав автора, гасить надо все его карточки разом, а не ту одну, на которой
 * нажали.
 */
let shownCards = [];

/** Записать в чёрный список или вычеркнуть из него. Возвращает ответ сервера или null. */
async function sendBlacklist(kind, value, label, blacklisted) {
	const response = await fetch('/api/blacklist', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ kind, value, label, blacklisted }),
	});

	const result = await response.json();

	if (result.error) {
		alert(result.error);
		return null;
	}

	return result;
}

/** Каких карточек на странице касается эта запись: пак — своей, автор — всех своих. */
function affectedCards(kind, value) {
	return shownCards
		.filter(({ pack }) => kind === 'author' ? pack.authors.includes(value) : pack.packKey === value)
		.map(({ card }) => card);
}

/**
 * Отправить пак или автора в чёрный список. Выдача при этом не перезагружается:
 * карточка гаснет и остаётся на месте с кнопкой «Отменить» — иначе пак исчезал
 * мгновенно, и промахнувшийся мышью человек не знал даже, что именно пропало.
 *
 * Насовсем они уходят при обновлении страницы, а возвращаются из профиля.
 */
async function addToBlacklist(kind, value, label) {
	const result = await sendBlacklist(kind, value, label, true);

	if (!result) {
		return;
	}

	// Сервер отвечает приведённым ключом (у автора — им же ищутся его паки),
	// и вычёркивать надо именно его, а не то написание, по которому нажали
	const cards = affectedCards(kind, value);

	const undo = async () => {
		if (await sendBlacklist(kind, result.value, label, false)) {
			for (const card of cards) {
				clearBanned(card);
			}
		}
	};

	for (const card of cards) {
		markBanned(card, kind, label, undo);
	}
}

/** Погасить карточку: она в чёрном списке, но пока никуда не делась. */
function markBanned(card, kind, label, undo) {
	if (card.querySelector('.card__ban')) {
		return;
	}

	card.classList.add('card--banned');

	const box = element('div', 'card__ban');
	box.append(iconText('ban', kind === 'author'
		? `Автор «${label}» в чёрном списке`
		: 'Пак в чёрном списке', 'card__ban-text'));

	const cancel = element('button', 'button button--ghost', 'Отменить');
	cancel.type = 'button';
	cancel.addEventListener('click', async () => {
		cancel.disabled = true;

		try {
			await undo();
		} finally {
			cancel.disabled = false;
		}
	});

	box.append(cancel, element('p', 'card__ban-note', 'Пропадёт из выдачи после обновления страницы. Вернуть — в профиле.'));
	card.append(box);
}

function clearBanned(card) {
	card.classList.remove('card--banned');
	card.querySelector('.card__ban')?.remove();
}

function renderCounters() {
	$('counters').innerHTML =
		`Паков: <b>${facets.total}</b>` +
		` · С оценкой: <b>${facets.rated}</b>` +
		` · Сыграно: <b id="playedCount">${facets.played}</b>`;
}

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
}

/**
 * Сколько фильтров сейчас сужают выдачу. Число висит на кнопке «Фильтры»:
 * на узком экране колонка свёрнута, и без него было бы не понять, почему паков
 * вдруг стало вдвое меньше.
 */
function countActiveFilters() {
	return state.levels.size
		+ state.topics.size
		+ state.languages.size
		+ state.tags.size
		+ (state.franchise ? 1 : 0)
		+ (state.subject ? 1 : 0)
		+ (state.author ? 1 : 0)
		+ (state.hidePlayed ? 1 : 0)
		+ (state.onlyPlayed ? 1 : 0)
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

/**
 * Дата пака для карточки: когда он появился в обсуждении. Время сообщения ВК
 * приходит числом, а у старых записей — только строкой вида «7 авг 2026 в 13:51»,
 * из которой берётся день.
 */
function packDate(pack) {
	if (pack.vkTs) {
		return new Date(pack.vkTs).toLocaleDateString('ru-RU');
	}

	if (pack.vkDate) {
		return pack.vkDate.replace(/\s+в\s+\d{1,2}:\d{2}.*$/i, '');
	}

	return null;
}

/**
 * Сколько раз пак играли. Плашка стоит в самом верху карточки и набрана мелко:
 * число тут важное — от него зависит, есть ли у пака оценка сложности, — но
 * читают его беглым взглядом, и занимать им целую строку под шапкой не за что.
 * Подробности (сколько доиграли до конца, сколько не хватает до оценки) ушли
 * в подсказку: на плашке остаётся только само число.
 *
 * Цвет заменяет собой пояснение: пока игр меньше минимума, плашка приглушена —
 * значит, оценки сложности у пака не будет.
 */
function createGames(pack) {
	const games = pack.stats?.startedGames ?? 0;
	const box = element('div', 'games');

	if (!pack.stats) {
		box.classList.add('games--unknown');
		box.append(element('span', 'games__value', '—'), element('span', 'games__unit', 'игр'));
		box.title = 'Сервис статистики SIGame этот пак не знает: его либо не играли онлайн, либо он лежит там под другим названием';
		return box;
	}

	const enough = games >= facets.minGames;
	box.classList.add(enough ? 'games--many' : 'games--few');

	box.append(
		element('span', 'games__value', formatNumber(games)),
		element('span', 'games__unit', plural(games, 'игра', 'игры', 'игр')),
	);

	const completed = pack.stats.completedGames ?? 0;

	// Доля доигранных до конца — сразу за числом запусков. Само по себе «сыграли
	// тысячу раз» ничего не говорит о том, досиживают ли пак: у одного тысяча
	// запусков и половина доигранных, у другого та же тысяча и каждый десятый.
	// Считается только когда есть от чего считать: на нуле запусков процента нет.
	if (games > 0) {
		const share = Math.round((completed / games) * 100);
		const done = element('span', 'games__done', `${share}%`);
		done.title = `Доиграли до конца ${formatNumber(completed)} из ${formatNumber(games)} запусков`;
		box.append(done);
	}

	box.title = enough
		? `Пак запускали ${formatNumber(games)} раз, доиграли до конца ${formatNumber(completed)}`
		: `Пак запускали ${formatNumber(games)} раз. Оценка сложности появляется от ${facets.minGames} игр — `
			+ `не хватает ещё ${formatNumber(facets.minGames - games)}`;

	return box;
}

/**
 * Почему у пака нет оценки. Порогов два, и назвать надо тот, который не взят:
 * раньше подсказка при любом раскладе обещала оценку «когда наберётся 100 игр»,
 * и на паке с двумя сотнями игр это выглядело обманом.
 */
function unratedReason(pack) {
	if (!pack.stats) {
		return 'Сервис статистики SIGame этот пак не знает, оценивать нечего';
	}

	const games = pack.stats.startedGames ?? 0;
	const shown = pack.stats.shown ?? 0;
	const parts = [];

	if (games < facets.minGames) {
		parts.push(`игр ${formatNumber(games)} из ${facets.minGames}`);
	}

	if (shown < facets.minShown) {
		parts.push(`показанных вопросов ${formatNumber(shown)} из ${facets.minShown}`);
	}

	if (parts.length === 0) {
		// Оба порога взяты, а уровня нет: значит, по паку не набралось ни одного ответа
		return 'Данных статистики не хватает, чтобы посчитать сложность';
	}

	return `Оценка появится, когда наберётся и то, и другое: ${parts.join(', ')}`;
}

/** Повторы франшиз: к чему пак возвращается снова и снова. */
function createFranchises(pack) {
	const franchises = pack.franchises ?? [];

	if (franchises.length === 0) {
		return null;
	}

	const box = element('div', 'repeats');
	box.append(iconText('repeat', 'Повторы:', 'repeats__title'));

	for (const franchise of franchises) {
		const chip = element('button', 'repeats__item');
		chip.type = 'button';
		chip.append(
			element('span', null, franchise.name),
			element('span', 'repeats__count', `×${franchise.themes}`),
		);
		chip.title = `${franchise.name}: ${franchise.themes} ${plural(franchise.themes, 'тема', 'темы', 'тем')}, `
			+ `${Math.round(franchise.share * 100)}% вопросов пака. Нажмите, чтобы найти все паки с этой франшизой`;

		if (franchise.share >= facets.franchiseDominantShare) {
			chip.classList.add('repeats__item--dominant');
		}

		chip.addEventListener('click', () => {
			state.franchise = franchise.name;
			state.page = 1;
			renderActiveFilters();
			load();
			window.scrollTo({ top: 0, behavior: 'smooth' });
		});

		box.append(chip);
	}

	return box;
}

/**
 * Описание пака словами того, кто его выложил, — текст сообщения из обсуждения.
 * Стоит сразу под темами, а не в «Подробнее»: это единственное на карточке,
 * написанное человеком, и разворачивать ради него спрятанный блок никто не станет.
 *
 * Длинные описания свёрнуты до четырёх строк: в обсуждении попадаются простыни
 * на десяток абзацев, и одна такая карточка вытянула бы собой всю колонку.
 */
function createDescription(pack) {
	if (!pack.commentText) {
		return null;
	}

	const box = element('div', 'description');
	// Ссылки в описании нажимаются: в обсуждении их пишут часто, а копировать
	// адрес из текста руками — последнее, чего ждут от карточки
	const text = appendLinked(element('div', 'description__text'), pack.commentText);
	const more = element('button', 'description__more', 'Показать полностью');
	more.type = 'button';
	more.hidden = true;

	more.addEventListener('click', () => {
		const opened = box.classList.toggle('description--open');
		more.textContent = opened ? 'Свернуть' : 'Показать полностью';
	});

	box.append(text, more);

	// Кнопка появится в measureDescriptions, когда карточка окажется на странице:
	// пока текст не разложен по строкам, сравнивать высоты не с чем

	return box;
}

/**
 * У каких описаний текст не поместился в четыре строки — тем и кнопка. Считается
 * разом по всей выдаче и обязательно после того, как карточки уже вставлены:
 * до вставки у текста нет ни ширины, ни переносов, и обе высоты равны нулю.
 *
 * Пересчитывается и при смене ширины окна: в колонке поуже то же описание занимает
 * больше строк, и кнопка нужна там, где её только что не было.
 *
 * Мерить пришлось руками, а не наблюдателем за размером: тот не срабатывает
 * на -webkit-box, а без него нет и обрезки по строкам.
 */
function measureDescriptions() {
	for (const box of document.querySelectorAll('.description')) {
		// Развёрнутое описание высотами не проверить: оно и должно прокручиваться,
		// а кнопка ему нужна, чтобы свернуться обратно
		if (box.classList.contains('description--open')) {
			continue;
		}

		const text = box.querySelector('.description__text');
		box.querySelector('.description__more').hidden = text.scrollHeight <= text.clientHeight + 1;
	}
}

/** Музыкальный ли пак: доля музыкальных вопросов взяла порог. */
function isMusical(pack) {
	return Boolean(pack.primaryTopic) && (pack.topicShares?.music ?? 0) >= facets.musicThreshold;
}

/**
 * Одна полоска долей. Каждый кусок подписан сам: раньше цвета приходилось
 * угадывать — подсказка висела на всей полоске разом и перечисляла всё, что
 * в ней есть, — а теперь наведение на голубой отрезок говорит «Игры: 42%».
 *
 * Куски меньше процента полоска всё равно показывает: тонкая полоска цвета
 * честнее, чем её отсутствие, — но целиться в неё мышью можно и мимо, поэтому
 * им задан наименьший размер.
 */
function createShareBar(parts, className, suffix) {
	const total = parts.reduce((sum, part) => sum + part.value, 0);

	if (total <= 0) {
		return null;
	}

	const bar = element('div', `shares__bar ${className}`);

	for (const part of parts) {
		if (part.value <= 0) {
			continue;
		}

		const percent = (part.value / total) * 100;
		const piece = element('span', `shares__part shares__part--${part.key}`);

		piece.style.width = `${percent}%`;
		// Меньше процента округляется в ноль, а куска в полоске это не отменяет:
		// «<1%» честнее, чем «0%» на видимой цветной полосе
		piece.title = `${part.name}: ${percent < 0.5 ? '<1' : Math.round(percent)}% ${suffix}`;
		bar.append(piece);
	}

	return bar;
}

/**
 * Подпись под полоской: из чего она состоит, словами — «50% Аниме, 30% Мультфильмы».
 *
 * Полоска показывает соотношение, но не называет его: чтобы прочитать доли,
 * приходилось наводить мышью на каждый кусок по очереди, а на телефоне мыши нет
 * вовсе, и цвета там не значили ничего. Точка перед словом того же цвета, что
 * и кусок полоски: без неё подпись и полоска остались бы двумя разными списками.
 *
 * Куски мельче половины процента в подпись не идут: в полоске тонкая цветная
 * черта честнее пустоты, а в строке «0% HTML» — только лишнее слово.
 */
function createShareLegend(parts) {
	const total = parts.reduce((sum, part) => sum + part.value, 0);

	if (total <= 0) {
		return null;
	}

	const legend = element('div', 'shares__legend');

	const visible = parts
		.map(part => ({ ...part, percent: (part.value / total) * 100 }))
		.filter(part => part.percent >= 0.5)
		.sort((a, b) => b.percent - a.percent);

	for (const part of visible) {
		const item = element('span', 'shares__legend-item');
		item.append(
			element('i', `shares__dot shares__part--${part.key}`),
			element('span', null, `${Math.round(part.percent)}% ${part.name}`),
		);
		legend.append(item);
	}

	return legend.children.length > 0 ? legend : null;
}

/** Полоска вместе с её подписью. */
function createShareRow(parts, className, suffix, title) {
	const bar = createShareBar(parts, className, suffix);

	if (!bar) {
		return null;
	}

	bar.title = title;

	const row = element('div', 'shares__row');
	row.append(bar);

	const legend = createShareLegend(parts);

	if (legend) {
		row.append(legend);
	}

	return row;
}

/**
 * Полоски долей под названием. Сверху — тематики, поделившие вопросы между собой,
 * снизу — из чего эти вопросы сделаны: текст, картинки, музыка, видео и html.
 *
 * Вторая полоска раньше показывала одну только музыку и оттого почти всегда была
 * недозаполненной: непонятно, то ли остальное — тишина, то ли просто ничего
 * не посчитано. Теперь в ней все виды содержимого, и она всегда полна на сотню.
 */
function createShares(pack) {
	const shares = pack.topicShares ?? {};
	const content = pack.contentStat ?? {};

	const topics = createShareRow(
		SHARE_ORDER.map(key => ({ key, name: topicInfo(key).name, value: shares[key] ?? 0 })),
		'shares__bar--topics',
		'вопросов пака',
		'О чём вопросы пака',
	);

	const contents = createShareRow(
		CONTENT_ORDER.map(key => ({ key, name: CONTENT_NAMES[key], value: content[key] ?? 0 })),
		'shares__bar--content',
		'содержимого пака',
		'Из чего сделаны вопросы',
	);

	if (!topics && !contents) {
		return null;
	}

	const box = element('div', 'shares');

	if (topics) {
		box.append(topics);
	}

	if (contents) {
		box.append(contents);
	}

	return box;
}

/**
 * Спецвопросы: аукционы, коты в мешке, вопросы без риска и вопросы для всех.
 * Отдельным числом, а не внутри общего счёта вопросов: пак, где котов два десятка,
 * играется совсем не так, как обычный, и по одной сотне вопросов этого не видно.
 *
 * Ноль показывается тоже — «в этом паке спецвопросов нет» само по себе сведение.
 * А вот у паков, разобранных до того, как их научились считать, числа нет вовсе,
 * и выдумывать вместо него ноль нельзя: это разные вещи.
 */
function createSpecials(pack) {
	if (pack.specialCount === null || pack.specialCount === undefined) {
		return null;
	}

	const box = iconText('special', pack.specialCount, pack.specialCount > 0 ? 'meta__specials' : null);

	const parts = Object.entries(pack.specialStat ?? {})
		.sort((a, b) => b[1] - a[1])
		.map(([key, count]) => `${specialName(key)}: ${count}`);

	box.title = pack.specialCount > 0
		? `Спецвопросов: ${pack.specialCount} (${parts.join(', ')})`
		: 'Спецвопросов в паке нет: ни аукционов, ни котов в мешке';

	return box;
}

function createCard(pack) {
	const card = element('div', `card${pack.played ? ' card--played' : ''}`);

	// Самая верхняя строка карточки: слева дата, справа — сколько раз играли.
	// Оба числа отвечают на один вопрос — «стоит ли вообще смотреть дальше»:
	// свежий пак или лежит с позапрошлого года, играют его или он никому не нужен.
	const top = element('div', 'card__top');
	const date = packDate(pack);

	if (date) {
		const dateNode = iconText('calendar', date, 'card__date');
		dateNode.title = pack.vkDate ? `Выложен в обсуждение: ${pack.vkDate}` : 'Когда пак появился в обсуждении';
		top.append(dateNode);
	} else {
		// Пустышка держит плашку игр справа, даже когда даты нет
		top.append(element('span', 'card__date card__date--empty'));
	}

	top.append(createGames(pack));
	card.append(top);

	const head = element('div', 'card__head');
	head.append(createLogo(pack));

	const titleBox = element('div', 'card__title');
	titleBox.append(element('h3', 'card__name', pack.name ?? pack.fileName ?? 'Без названия'));

	if (pack.authors.length > 0) {
		const authors = element('p', 'card__authors');

		pack.authors.forEach((author, index) => {
			if (index > 0) {
				authors.append(document.createTextNode(', '));
			}

			// Число в скобках — сколько всего паков у этого автора. По одному имени
			// не видно разницы между тем, кто выложил тридцать паков, и тем, у кого
			// он единственный, а разница эта решает, стоит ли нажимать на имя
			const packs = pack.authorPacks?.[index] ?? 1;

			const link = element('button', 'author-link');
			link.type = 'button';
			link.append(element('span', null, author), element('span', 'author-link__count', `(${packs})`));
			link.title = `У автора «${author}» ${packs} ${plural(packs, 'пак', 'пака', 'паков')}. `
				+ 'Нажмите, чтобы показать их все';
			link.addEventListener('click', () => selectAuthor(author));
			authors.append(link);

			// Знак запрета стоит у самого имени, а не в общем меню внизу карточки:
			// в чёрный список отправляют именно этого автора, и нажимать надо там,
			// где он написан. Ростом знак ровно с имя, чтобы не разгонять строку
			if (canHide()) {
				const ban = element('button', 'author-ban');
				ban.type = 'button';
				ban.append(icon('ban'));
				ban.title = `Добавить в чёрный список автора «${author}»`;
				ban.setAttribute('aria-label', ban.title);
				ban.addEventListener('click', () => addToBlacklist('author', author, author));
				authors.append(ban);
			}
		});

		titleBox.append(authors);
	}

	// Одна строка от модели про то, что вообще в паке: «Вселенная Гарри Поттера».
	// Помечена как AI: это пересказ нейросети по темам пака, а не слова автора.
	if (pack.summary) {
		const summary = element('p', 'card__summary');
		const mark = element('span', 'ai-mark', 'AI');
		mark.title = 'Составлено нейросетью по темам пака';
		summary.append(mark, document.createTextNode(pack.summary));
		summary.title = 'Краткое описание пака по его темам, составлено нейросетью';
		titleBox.append(summary);
	}

	const level = pack.stats?.level ?? null;
	const badges = element('div', 'badges');

	const badge = level
		? element('span', `badge badge--${pack.stats.levelKey}`, pack.stats.levelName)
		: element('span', 'badge badge--none', 'Нет оценки');

	// Ступень за неточные ответы стоит назвать: иначе пак, где отвечали на 70%
	// вопросов, выглядит средним без всякой причины
	const bumped = level !== null && pack.stats.rightPercent !== null && pack.stats.rightPercent < facets.hardRight;

	badge.title = level
		? `Оценка по статистике: отвечали на ${pack.stats.takePercent.toFixed(1)}% вопросов на ${formatNumber(pack.stats.startedGames)} играх`
			+ (bumped
				? `. Ступень добавлена за неточные ответы: правильных всего ${pack.stats.rightPercent.toFixed(1)}%, меньше ${facets.hardRight}%`
				: '')
		: unratedReason(pack);

	badges.append(badge);

	// Проценты попыток и правильных ответов — рядом со сложностью: уровень считается
	// из первого, и цифру за ярлыком удобнее видеть, чем искать в подсказке.
	// Слева жёлтым доля попыток ответить, справа зелёным доля правильных:
	// два разных числа стоят рядом, и цвет не даёт их спутать.
	if (pack.stats && (pack.stats.takePercent !== null || pack.stats.rightPercent !== null)) {
		const numbers = element('span', 'badge-stats');

		if (pack.stats.takePercent !== null) {
			const take = element('span', 'badge-stats__value badge-stats__value--take', `${pack.stats.takePercent.toFixed(1)}%`);
			take.title = 'Доля вопросов, на которые решились ответить. По ней и считается сложность';
			numbers.append(take, element('span', 'badge-stats__label', 'отвечали'));
		}

		if (pack.stats.rightPercent !== null) {
			const right = element('span', 'badge-stats__value badge-stats__value--right', `${pack.stats.rightPercent.toFixed(1)}%`);
			right.title = 'Доля правильных ответов из тех, что вообще прозвучали';
			numbers.append(right, element('span', 'badge-stats__label', 'правильных'));
		}

		badges.append(numbers);
	}

	/** Ярлык тематики: по клику показывает все такие же паки. */
	const createTopicBadge = (key, share, title) => {
		const info = topicInfo(key);
		const percent = share !== null && share !== undefined && key !== 'mixed' ? ` ${Math.round(share * 100)}%` : '';
		const badge = element('span', `badge badge--topic topic--${key}`);
		badge.append(topicIcon(key), element('span', null, `${info.packName}${percent}`));
		badge.title = title;

		// Клик по ярлыку — это «покажи только такие»: прежний набор типов заменяется,
		// а не дополняется. Набирать несколько удобнее галочками слева
		badge.addEventListener('click', () => {
			state.topics = new Set([key]);
			state.page = 1;
			renderTopics();
			renderActiveFilters();
			load();
		});

		return badge;
	};

	// Дополнительный тип: пак целиком про одно — про Вархаммер, про футбол,
	// про Гарри Поттера. Берётся самый частый предмет пака, если он занял больше
	// половины вопросов; предметы приходят отсортированными от частых к редким,
	// поэтому это первый в списке (см. computeFranchises).
	const mostCommon = (pack.franchises ?? [])[0];
	const subject = mostCommon && mostCommon.share >= facets.subjectPackShare ? mostCommon : null;

	// Солянка вместе с таким типом не показывается: «Солянка · Футбол» —
	// это спор с самим собой. Солянкой пак про футбол числится только потому,
	// что спорт живёт в «прочем» и ни одна из пяти тематик порога не берёт;
	// сказать про такой пак «он про футбол» и точнее, и полезнее.
	if (pack.primaryTopic && !(subject && pack.primaryTopic === 'mixed')) {
		badges.append(createTopicBadge(
			pack.primaryTopic,
			pack.primaryShare,
			pack.primaryTopic === 'mixed'
				? `Ни одна тематика не набрала ${Math.round(facets.topicThreshold * 100)}% вопросов`
				: `${topicInfo(pack.primaryTopic).name}: ${Math.round(pack.primaryShare * 100)}% вопросов пака`,
		));
	}

	if (subject) {
		const badge = element('button', 'badge badge--subject');
		badge.type = 'button';
		badge.append(icon('target'), element('span', null, `${subject.name} ${Math.round(subject.share * 100)}%`));
		badge.title = `Пак целиком про одно: «${subject.name}» — ${subject.themes} `
			+ `${plural(subject.themes, 'тема', 'темы', 'тем')} и ${Math.round(subject.share * 100)}% вопросов пака. `
			+ 'Нажмите, чтобы показать все паки этого типа';

		badge.addEventListener('click', () => {
			state.subject = subject.name;
			state.page = 1;
			renderSubjects();
			renderActiveFilters();
			load();
			window.scrollTo({ top: 0, behavior: 'smooth' });
		});

		badges.append(badge);
	}

	// Музыка стоит вторым ярлыком: она не спорит с основной тематикой, а дополняет её —
	// аниме-пак с опенингами и аниме-пак, и музыкальный сразу.
	if (isMusical(pack) && pack.primaryTopic !== 'music') {
		badges.append(createTopicBadge(
			'music',
			pack.topicShares.music,
			`По музыке отгадывается ${Math.round(pack.topicShares.music * 100)}% вопросов пака`,
		));
	}

	titleBox.append(badges);
	head.append(titleBox);
	card.append(head);

	// Оценка игроков — то, чего не знает статистика SIGame: она считает, сколько
	// раз пак запускали, а не понравился ли он. Стоит сразу под шапкой, где
	// раньше было число игр: место читаемое, а вопрос «стоит ли играть» решает
	// именно она.
	//
	// Оценить можно только сыгранный пак: иначе это оценка обложки, а не игры.
	// Поэтому блок оценок пересобирается, когда отметку ставят или снимают, —
	// звёзды тут же становятся нажимаемыми (см. кнопку «Отметить сыгранным»).
	const buildRating = () => {
		const canRate = Boolean(user) && pack.played;

		const box = createRating(pack, {
			canRate,
			reason: !user
				? 'Оценивать паки можно, войдя через Discord'
				: 'Оценка появится, когда пак будет отмечен сыгранным',
			minRatings: facets.minRatings,
			onRate: async score => {
				const response = await fetch('/api/rate', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ packKey: pack.packKey, score }),
				});

				const result = await response.json();

				if (result.error) {
					throw new Error(result.error);
				}

				pack.rating = result;
				return result;
			},
		});

		// Пак отмечен сыгранным — значит, дело за оценкой, и звёзды становятся
		// в карточке главным: встают по центру отдельной строкой и вырастают вдвое.
		// Половина звезды здесь — целый балл, а мелкими она шириной в три пикселя,
		// и «7 из 10» ставилось наугад; в крупные попадают с первого раза.
		if (canRate) {
			box.classList.add('rating--big');
		}

		return box;
	};

	let rating = buildRating();
	card.append(rating);

	const shares = createShares(pack);

	if (shares) {
		card.append(shares);
	}

	const repeats = createFranchises(pack);

	if (repeats) {
		card.append(repeats);
	}

	if (pack.tags.length > 0) {
		const tags = element('div', 'tags');

		for (const tag of pack.tags) {
			const chip = element('span', 'tag', tag);
			chip.title = `Показать паки с темой «${tag}»`;
			chip.addEventListener('click', () => {
				state.tags.add(tag);
				state.page = 1;
				renderTags();
				renderActiveFilters();
				load();
			});
			tags.append(chip);
		}

		card.append(tags);
	}

	// Описание от автора идёт сразу за темами: темы говорят, о чём пак, описание —
	// что за ними стоит. Раньше оно лежало в «Подробнее», куда заглядывают в
	// последнюю очередь, — и половина карточек выглядела так, будто их не описывали
	const description = createDescription(pack);

	if (description) {
		card.append(description);
	}

	const meta = element('div', 'meta');
	const size = formatSize(pack.size);

	// Даты здесь больше нет: она вынесена в самую верхнюю строку карточки,
	// рядом с числом игр

	if (pack.questionCount) {
		const questions = iconText('question', pack.questionCount);
		questions.title = `Вопросов в паке: ${pack.questionCount}`;
		meta.append(questions);
	}

	if (pack.roundCount) {
		meta.append(iconText('rounds', `${pack.roundCount} ${plural(pack.roundCount, 'раунд', 'раунда', 'раундов')}`));
	}

	// Спецвопросы стоят отдельным числом: аукционы и коты в мешке меняют игру
	// сильнее, чем что-либо ещё в этих цифрах, а в общем счёте вопросов их не видно
	const specials = createSpecials(pack);

	if (specials) {
		meta.append(specials);
	}

	if (size) {
		meta.append(iconText('box', size));
	}

	if (pack.language) {
		const language = iconText('globe', pack.language.split('-')[0].toUpperCase());
		language.title = `Язык пака по его файлу: ${pack.language}`;
		meta.append(language);
	}

	// Числа игр здесь больше нет: оно вынесено плашкой в самый верх карточки

	card.append(meta);

	const details = element('details', 'details');
	details.append(element('summary', null, 'Подробнее'));
	const body = element('div', 'details__body');

	if (pack.rounds.length > 0) {
		const roundsBox = element('div');

		for (const round of pack.rounds) {
			const item = element('div', 'round');
			const name = element('b', null, round.name);
			item.append(name);

			if (round.themes.length > 0) {
				item.append(document.createTextNode(`: ${round.themes.map(theme => theme.name).join(', ')}`));
			}

			roundsBox.append(item);
		}

		body.append(roundsBox);
	}

	// Описания здесь больше нет: оно поднято под темы, на видное место

	const source = element('div');

	const link = element('a', null, 'Источник');
	link.href = `${pack.vkTopic}?post=${pack.vkComment}`;
	link.target = '_blank';
	link.rel = 'noreferrer noopener';
	link.title = 'Сообщение в обсуждении, откуда взят файл';
	source.append(link);

	if (pack.vkDate) {
		source.append(document.createTextNode(`, ${pack.vkDate}`));
	}

	body.append(source);
	details.append(body);
	card.append(details);

	const actions = element('div', 'card__actions');

	actions.append(createPlayLink(pack, facets.playerUri));

	const download = element('a', 'button', 'Скачать');
	download.href = pack.url;
	download.target = '_blank';
	download.rel = 'noreferrer noopener';
	actions.append(download);

	const played = element('button', `button${pack.played ? ' button--active' : ''}`);
	played.type = 'button';

	// Кнопка остаётся на месте и без входа, но не нажимается: убери её совсем —
	// и на сайте не осталось бы места, где сказано, что отметки вообще есть
	// и чего им не хватает. Подсказка ровно об этом и говорит.
	played.disabled = !canMark();

	if (!canMark()) {
		played.title = 'Отмечать паки сыгранными можно, войдя через Discord: иначе у отметки нет хозяина';
	}

	const renderPlayed = () => {
		played.textContent = '';

		if (pack.played) {
			played.append(icon('check'), element('span', null, 'Сыграно'));
		} else {
			played.append(element('span', null, 'Отметить сыгранным'));
		}
	};

	renderPlayed();

	played.addEventListener('click', async () => {
		played.disabled = true;

		try {
			const response = await fetch('/api/played', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id: pack.id, played: !pack.played }),
			});

			const result = await response.json();
			pack.played = result.played;

			renderPlayed();
			played.classList.toggle('button--active', pack.played);
			card.classList.toggle('card--played', pack.played);

			// Оценивать можно только сыгранное — значит, звёзды меняют своё
			// состояние вместе с этой кнопкой, а не после обновления страницы
			const next = buildRating();
			rating.replaceWith(next);
			rating = next;

			facets.played += pack.played ? 1 : -1;
			renderCounters();

			if (state.hidePlayed && pack.played) {
				load();
			}
		} finally {
			played.disabled = !canMark();
		}
	});

	actions.append(played);

	// Кнопка чёрного списка стоит в том же ряду, что и остальные действия, и видна
	// всегда: раньше она пропадала с карточки целиком, стоило не завести ключи
	// Discord, — и на сайте попросту не было места, где сказано, что чёрный список
	// вообще существует и чего ему не хватает. Теперь она есть, а чего не хватает,
	// говорит её меню.
	actions.append(createHideButton(pack));

	card.append(actions);

	return card;
}

/**
 * «Добавить в чёрный список» сам пак. Автор сюда больше не относится: его знак
 * запрета стоит у самого имени в шапке карточки — там, где написано, о ком речь.
 *
 * От подписи кнопка избавлена нарочно: рядом с «Отметить сыгранным» она стояла
 * такой же ширины и тянула на себя столько же внимания, сколько главное действие
 * карточки. Красный знак запрета читается с одного взгляда и не спорит с соседями,
 * а что он значит, говорит подсказка.
 *
 * Меню остаётся только для тех случаев, когда прятать некуда: без входа на общем
 * сайте списку негде храниться, и кнопка, которая молча ничего не делает, хуже
 * отсутствующей — вместо действия она открывает объяснение.
 */
function createHideButton(pack) {
	const wrap = element('div', 'hide');
	const button = element('button', 'button button--ghost button--ban');
	button.type = 'button';
	button.append(icon('ban'));

	const name = pack.name ?? pack.fileName ?? 'без названия';

	button.setAttribute('aria-label', `Добавить в чёрный список пак «${name}»`);
	button.title = canHide()
		? `Добавить в чёрный список пак «${name}»`
		: 'Чёрный список: почему пак нельзя спрятать';

	const menu = element('div', 'hide__menu');
	menu.hidden = true;

	if (canHide()) {
		button.addEventListener('click', event => {
			event.stopPropagation();
			addToBlacklist('pack', pack.packKey, pack.name ?? pack.fileName ?? '');
		});

		wrap.append(button);
		return wrap;
	}

	if (facets.hasDiscord) {
		// Список личный, и хранить его без хозяина негде. Но молчать об этом
		// нельзя: кнопка, которая ничего не делает и не говорит почему, хуже
		// отсутствующей
		menu.append(element('p', 'hide__note',
			'Чёрный список личный: он привязан к учётной записи. Войдите, и паки с авторами можно будет прятать отсюда.'));

		const login = element('a', 'hide__item hide__item--login', 'Войти через Discord');
		login.href = '/auth/discord';
		menu.append(login);
	} else {
		// Вход на этой установке не заведён вовсе. Прежде кнопка в этом случае
		// просто не появлялась, и о чёрном списке нельзя было узнать ниоткуда
		menu.append(element('p', 'hide__note',
			'Чёрный список привязан к учётной записи, а вход через Discord на этом сайте не настроен. '
			+ 'Чтобы он появился, заведите приложение на discord.com/developers/applications и положите его ключи '
			+ 'в data/discord-client-id.txt и data/discord-client-secret.txt — подробности в README.'));
	}

	button.addEventListener('click', event => {
		event.stopPropagation();
		const opening = menu.hidden;

		// Открытым остаётся только одно меню: два висящих списка поверх выдачи
		// читаются как один, и промахнуться в них проще, чем попасть
		for (const other of document.querySelectorAll('.hide__menu')) {
			other.hidden = true;
		}

		menu.hidden = !opening;
	});

	wrap.append(button, menu);
	return wrap;
}

function renderPager(total) {
	const pager = $('pager');
	pager.textContent = '';

	const pageCount = Math.ceil(total / state.pageSize);

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
				load();
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

	const visible = [...pages].filter(p => p >= 1 && p <= pageCount).sort((a, b) => a - b);
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

function bind() {
	let searchTimer = null;

	$('search').addEventListener('input', event => {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => {
			state.search = event.target.value.trim();
			state.page = 1;
			load();
		}, 250);
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

	// Меню чёрного списка закрывается щелчком мимо него: иначе оно висит поверх
	// выдачи, пока не нажмёшь ту же кнопку ещё раз
	document.addEventListener('click', () => {
		for (const menu of document.querySelectorAll('.hide__menu')) {
			menu.hidden = true;
		}
	});

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
	state.hidePlayed = false;
	state.onlyPlayed = false;
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
	$('hidePlayed').checked = false;
	$('onlyPlayed').checked = false;
	$('tagSearch').value = '';
	$('subjectSearch').value = '';
	$('sort').value = 'added';
	$('dir').value = 'desc';

	renderLevels();
	renderUnrated();
	renderTopics();
	renderSubjects();
	renderLanguages();
	renderTags();
	renderActiveFilters();
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

	if (query.get('sort')) {
		state.sort = query.get('sort');
	}

	$('search').value = state.search;
	$('sort').value = state.sort;
}

async function start() {
	// Фильтры из адреса читаются до всякой сети: они берутся из самой ссылки,
	// и без них нельзя составить запрос выдачи.
	readUrlState();

	// Оба обращения к серверу уходят разом. Выдача не зависит от настроек —
	// ждать их ответа, чтобы только начать спрашивать паки, значило дарить
	// каждому открытию страницы лишнюю ходку до сервера.
	const packages = fetch(`/api/packages?${buildQuery()}`);

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

	// На хостинге собирать базу нечем, и ссылки на страницу обновления там быть не должно
	if (facets.readOnly) {
		$('updateLink').remove();
	}

	renderAccount();
	renderLevels();
	renderUnrated();
	renderTopics();
	renderSubjects();
	renderLanguages();
	renderTags();
	renderCounters();
	renderSortHint();
	bind();
	await load(packages);
}

start();
