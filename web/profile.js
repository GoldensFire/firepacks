// Профиль: библиотека сыгранного и что из неё видно про вкусы владельца.
//
// Имя берётся из Discord, если человек вошёл. Без входа остаётся прежняя подпись
// из localStorage: сайт задумывался как локальный, и требовать учётную запись
// ради страницы «во что я играл» не за что.
//
// Отметки «сыграно» при этом по-прежнему принадлежат всей установке целиком,
// а не конкретному человеку, — в отличие от оценок и чёрного списка, у которых
// хозяин есть. На хостинге это заметно, и привязать их к user_id стоит следующим шагом.

'use strict';

const LEVEL_ORDER = [4, 3, 2, 1];
/** Порядок тот же, что в колонке фильтров библиотеки (см. web/app.js). */
const TOPIC_ORDER = ['mixed', 'anime', 'manga', 'games', 'movies', 'cartoons', 'books', 'comics', 'music', 'unknown'];

const EXTRA_TOPICS = {
	mixed: { name: 'Солянка', packName: 'Солянка' },
	unknown: { name: 'Без разметки', packName: 'Без разметки' },
};

/** Как человек себя назвал. Ничего, кроме подписи, за этим именем не стоит. */
const NAME_KEY = 'firepacks.profile.name';

/**
 * По столько секунд считается каждый вопрос сыгранного пака. Число взято не
 * из статистики, а из здравого смысла: вопрос читают, думают над ним и отвечают,
 * и на круг это выходит примерно четверть минуты. Настоящей длительности игры
 * сайт не знает и знать не может — он видит только файлы паков.
 */
const SECONDS_PER_QUESTION = 15;

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

let facets = null;
let profile = null;

/** Какая вкладка открыта: 'planned' или 'played'. Переживает перерисовку страницы. */
let tab = 'planned';

/**
 * Какие страницы списков открыты. Паки приезжают по две дюжины за раз — столько
 * же, сколько в библиотеке, — и по той же причине: две сотни отметок это две
 * сотни полных паков в одном ответе, и страница «во что я играл» открывалась
 * дольше, чем страница со всей библиотекой сразу.
 *
 * Числа профиля от этого не пострадали: сложности, тематики и авторы по-прежнему
 * считаются по всему сыгранному — просто считает их сервер (см. getProfile).
 */
const pages = { played: 1, planned: 1 };

const topicInfo = key => facets.topicNames[key] ?? EXTRA_TOPICS[key] ?? { name: key, packName: key };

/** Кто вошёл через Discord, или null. */
let user = null;

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
 * Личный чёрный список целиком — и единственное место, где он есть: в библиотеке
 * его больше нет ни в колонке фильтров, ни где-либо ещё. Спрятанные паки уходят
 * из выдачи при первом же обновлении страницы, и вернуть их можно только отсюда.
 */
function renderBlacklist() {
	const block = $('blacklistBlock');
	const items = profile.blacklist ?? [];

	// Без входа список тоже бывает: на своей машине он принадлежит установке,
	// как и отметки «сыграно» (см. config.localBlacklist)
	const visible = Boolean(user) || facets?.localBlacklist === true;

	block.hidden = !visible;

	if (!visible) {
		return;
	}

	const box = $('blacklist');
	box.textContent = '';

	if (items.length === 0) {
		box.append(element('p', 'hint', 'Пока пусто.'));
		return;
	}

	for (const item of items) {
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
		box.append(chip);
	}
}

/** Крупные числа профиля: сколько всего сыграно и что за этим стоит. */
function renderNumbers() {
	const box = $('numbers');
	box.textContent = '';

	const played = profile.total;
	const share = facets.total > 0 ? Math.round((played / facets.total) * 100) : 0;

	const add = (value, label, title) => {
		const item = element('div', 'profile__number');
		item.append(element('span', 'profile__number-value', value), element('span', 'profile__number-label', label));
		item.title = title;
		box.append(item);
	};

	add(formatNumber(played), plural(played, 'пак сыгран', 'пака сыграно', 'паков сыграно'),
		'Копии одного и того же пака считаются за один');
	add(`${share}%`, 'от всей библиотеки', `Всего в библиотеке ${formatNumber(facets.total)} паков`);
	add(formatNumber(profile.questions), plural(profile.questions, 'вопрос', 'вопроса', 'вопросов'),
		'Столько вопросов лежит в сыгранных паках — не столько прозвучало за столом');

	// Числа «в планах» здесь больше нет: оно стоит прямо на вкладке
	// «Запланировано» и повторять его в колонке незачем
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
 * Считается это всё по 15 секунд на вопрос, и число получается заведомо
 * приблизительное. Поэтому у подписи есть подсказка, где расчёт назван прямо:
 * человек должен видеть, что перед ним прикидка, а не показания секундомера.
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

/**
 * Вкладки «Запланировано» и «Сыграно». Списки эти нужны порознь: вместе они
 * на всю библиотеку длиной, и второй всё равно оказывался за краем экрана.
 */
function renderTabs() {
	const counts = {
		planned: profile?.plannedTotal ?? 0,
		played: profile?.total ?? 0,
	};

	$('tabPlannedCount').textContent = formatNumber(counts.planned);
	$('tabPlayedCount').textContent = formatNumber(counts.played);

	for (const [key, button, panel] of [
		['planned', $('tabPlanned'), $('plannedBlock')],
		['played', $('tabPlayed'), $('playedBlock')],
	]) {
		const active = key === tab;

		button.classList.toggle('tab--active', active);
		button.setAttribute('aria-selected', String(active));
		panel.hidden = !active;
	}
}

function bindTabs() {
	for (const [key, button] of [['planned', $('tabPlanned')], ['played', $('tabPlayed')]]) {
		button.addEventListener('click', () => {
			tab = key;
			renderTabs();
		});
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
	const authors = profile.favouriteAuthors;

	if (authors.length === 0) {
		return;
	}

	$('authorsBlock').hidden = false;
	const box = $('authors');
	box.textContent = '';

	for (const author of authors) {
		const chip = element('a', 'profile__chip');
		// hidePlayed=0 — потому что вся эта страница про сыгранное, а библиотека
		// сыгранное по умолчанию прячет: без приписки под числом «сыграно 7 паков
		// этого автора» открывалась бы выдача, где именно этих семи и нет
		chip.href = `/?author=${encodeURIComponent(author.name)}&hidePlayed=0`;
		chip.append(
			element('span', null, author.name),
			element('span', 'profile__chip-count', String(author.count)),
		);
		chip.title = `Сыграно ${author.count} ${plural(author.count, 'пак', 'пака', 'паков')} этого автора`;
		box.append(chip);
	}
}

/**
 * Карточка сыгранного пака. Короче, чем в библиотеке: здесь уже не выбирают,
 * во что играть, а вспоминают, во что играли, — значит, важны название, когда
 * это было, и возможность вернуться к паку или снять отметку.
 */
function createCard(pack, options = {}) {
	const planned = options.planned === true;
	const card = element('div', 'card card--clickable');

	// Карточка целиком ведёт на страницу пака — как и в библиотеке (см. card.js).
	// Кнопки внизу до этого обработчика не доходят: они останавливают событие
	// сами, а здесь их всего две и обе — <button>.
	card.addEventListener('click', event => {
		if (event.target.closest('a, button')) {
			return;
		}

		window.location.href = pack.slug ? `/pack/${pack.id}-${pack.slug}` : `/pack/${pack.id}`;
	});

	const head = element('div', 'card__head');
	head.append(createLogo(pack));

	const titleBox = element('div', 'card__title');
	titleBox.append(element('h3', 'card__name', pack.name ?? pack.fileName ?? 'Без названия'));

	if (pack.authors.length > 0) {
		titleBox.append(element('p', 'card__authors', pack.authors.join(', ')));
	}

	const badges = element('div', 'badges');
	const level = pack.stats?.level ?? null;

	badges.append(level
		? element('span', `badge badge--${pack.stats.levelKey}`, pack.stats.levelName)
		: element('span', 'badge badge--none', 'Нет оценки'));

	if (pack.primaryTopic) {
		const info = topicInfo(pack.primaryTopic);
		const badge = element('span', `badge badge--topic topic--${pack.primaryTopic}`);
		badge.append(topicIcon(pack.primaryTopic), element('span', null, info.packName));
		badges.append(badge);
	}

	titleBox.append(badges);
	head.append(titleBox);
	card.append(head);

	const meta = element('div', 'meta');

	if (pack.markedAt) {
		const date = iconText(planned ? 'bookmark' : 'check', new Date(pack.markedAt).toLocaleDateString('ru-RU'), 'meta__date');
		date.title = planned ? 'Когда пак отложили на будущее' : 'Когда пак был отмечен сыгранным';
		meta.append(date);
	}

	if (pack.questionCount) {
		const questions = iconText('question', pack.questionCount);
		questions.title = `Вопросов в паке: ${pack.questionCount}`;
		meta.append(questions);
	}

	if (pack.specialCount !== null && pack.specialCount !== undefined) {
		const specials = iconText('special', pack.specialCount);
		specials.title = `Спецвопросов: ${pack.specialCount}`;
		meta.append(specials);
	}

	if (pack.stats?.startedGames) {
		const games = iconText('gamepad', formatNumber(pack.stats.startedGames));
		games.title = 'Сколько раз пак запускали по данным статистики SIGame';
		meta.append(games);
	}

	const size = formatSize(pack.size);

	if (size) {
		meta.append(iconText('box', size));
	}

	card.append(meta);

	const actions = element('div', 'card__actions');
	actions.append(createPlayLink(pack, facets.playerUri));

	// У запланированного пака второе действие своё: не «убрать из сыгранного»,
	// а «сыграно» — за него как раз садятся, и отметка сама уберёт его из планов
	// (см. setPlayed на сервере). Передумать можно третьей кнопкой.
	if (planned) {
		const done = element('button', 'button', 'Сыграно');
		done.type = 'button';
		done.title = 'Отметить сыгранным. Из запланированного пак при этом уйдёт';
		done.addEventListener('click', () => mark(done, '/api/played', { id: pack.id, played: true }));

		const forget = element('button', 'button button--ghost', 'Убрать из планов');
		forget.type = 'button';
		forget.addEventListener('click', () => mark(forget, '/api/planned', { id: pack.id, planned: false }));

		actions.append(done, forget);
		card.append(actions);

		return card;
	}

	const remove = element('button', 'button', 'Убрать из сыгранного');
	remove.type = 'button';
	remove.addEventListener('click', () => mark(remove, '/api/played', { id: pack.id, played: false }));

	actions.append(remove);
	card.append(actions);

	return card;
}

/** Отметка со страницы профиля: отправить и перечитать страницу целиком. */
async function mark(button, url, body) {
	button.disabled = true;

	try {
		await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});

		await refresh();
	} catch {
		button.disabled = false;
	}
}

/**
 * Запланированное: паки, отобранные на будущий вечер, — за этим страницу
 * и открывают чаще всего, поэтому список стоит выше сыгранного.
 *
 * Без входа на общем сайте отметок здесь нет: они лежат в самом браузере,
 * а страница показывает то, что знает сервер (то же самое, что и с сыгранным).
 */
/**
 * Один из двух списков профиля. Устроены они одинаково — сетка карточек, строка
 * «показаны такие-то из стольких-то» и кнопки страниц, — и различаются только
 * тем, что в них лежит и что написано в пустом.
 *
 * @param {string} list 'played' или 'planned'
 * @param {object} nodes на чём рисовать: сетка, строка над ней, кнопки страниц
 * @param {string} empty что написать, когда список пуст
 * @param {Function} tail чем закончить строку над списком, если есть чем
 */
function renderList(list, nodes, empty, tail = null) {
	const packs = (list === 'planned' ? profile.planned : profile.packages) ?? [];
	const total = (list === 'planned' ? profile.plannedTotal : profile.total) ?? 0;
	const grid = $(nodes.grid);
	const info = $(nodes.info);

	grid.textContent = '';
	info.textContent = '';

	if (total === 0) {
		// Без входа отметки лежат в самом браузере и до профиля не доходят: он
		// показывает то, что знает сервер. Сказать об этом надо здесь — иначе
		// человек, отметивший вчера десяток паков, решит, что они пропали.
		const anonymous = !user && facets.localBlacklist !== true;

		grid.append(element('div', 'empty', anonymous
			? `${empty.what} Пока входа нет, отметки живут в самом браузере и сюда не попадают: `
				+ 'войдите через Discord — они переедут в учётную запись.'
			: `${empty.what} ${empty.how}`));

		$(nodes.pager).textContent = '';
		return;
	}

	const pageSize = profile.pageSize ?? packs.length;

	// Последний пак со страницы могли только что убрать — тогда страницы с таким
	// номером больше нет, и стоять на ней значит смотреть в пустоту
	if (packs.length === 0) {
		pages[list] = Math.max(1, Math.ceil(total / pageSize));
		refresh();
		return;
	}

	for (const pack of packs) {
		grid.append(createCard(pack, { planned: list === 'planned' }));
	}

	const from = (pages[list] - 1) * pageSize + 1;

	info.append(document.createTextNode(`Показаны ${from}–${from + packs.length - 1} из ${total}, ${empty.order}`));

	if (tail) {
		tail(info);
	}

	renderPages($(nodes.pager), {
		page: pages[list],
		pageSize,
		total,
		onGo: page => {
			pages[list] = page;
			refresh();
		},
	});
}

/**
 * Запланированное: паки, отобранные на будущий вечер, — за этим страницу
 * и открывают чаще всего, поэтому список стоит первой вкладкой.
 */
function renderPlanned() {
	renderList('planned', { grid: 'plannedGrid', info: 'plannedInfo', pager: 'plannedPager' }, {
		what: 'Здесь собираются паки, отложенные на будущее.',
		how: 'Отложить можно в библиотеке — кнопкой «Запланировать» на карточке.',
		order: 'сначала отложенные недавно',
	}, info => {
		// Ссылка в библиотеку с уже выставленным отбором: здесь список целиком,
		// а там по нему можно искать теми же фильтрами, что и по всей базе.
		// hidePlayed=0 — чтобы список и там остался целым: отложить можно и сыгранный
		// пак, а библиотека сыгранное по умолчанию прячет
		const inLibrary = element('a', null, 'показать в библиотеке');
		inLibrary.href = '/?onlyPlanned=1&hidePlayed=0';

		info.append(document.createTextNode(' · '), inLibrary);
	});
}

function renderLibrary() {
	renderList('played', { grid: 'grid', info: 'resultInfo', pager: 'pager' }, {
		what: 'Здесь появятся паки, отмеченные сыгранными.',
		how: 'Отметить можно в библиотеке — кнопкой на карточке.',
		order: 'сначала недавние',
	});
}

// ————— список файлом —————
//
// Формат описан там, где его читает сервер (см. src/packlist.js).
// Здесь только два конца: собрать файл из того, что показано на странице,
// и отдать принесённый файл серверу — опознать паки по названиям.

const LIST_FORMAT = 'sigame-pack-list';
const LIST_VERSION = 1;

/** Как назвать скачиваемый файл: с датой, чтобы вчерашний не затирался сегодняшним. */
const listFileName = () => `firepacks-${new Date().toISOString().slice(0, 10)}.json`;

/**
 * Записи файла из того, что знает страница. Порядок тот же, что в списках:
 * сначала недавнее — файл читают глазами, и сверху должно стоять то же самое,
 * что стоит сверху на странице.
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
 * знает сервер, и спрашиваются они целиком: на странице их видно по две дюжины,
 * а файл со страницы сыгранного врал бы про то, во что играли. До входа на общем
 * сайте отметки лежат в браузере одними ключами, и названия к ним приходится
 * спрашивать отдельно — в файл идёт то, что человек прочитает, а не
 * «b88b8a6e…\nАниме пак № 5».
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
 * Перечитать страницу целиком. Зовётся и при открытии, и после каждой отметки,
 * и при переходе на другую страницу списка: ответ теперь весит две дюжины паков,
 * и разбирать, что именно из него менять, дороже, чем перерисовать всё.
 */
async function refresh() {
	const query = new URLSearchParams({
		playedPage: String(pages.played),
		plannedPage: String(pages.planned),
	});

	[facets, profile] = await Promise.all([
		fetch('/api/facets').then(r => r.json()),
		fetch(`/api/profile?${query}`).then(r => r.json()),
	]);

	user = facets.user ?? null;

	renderTopbar(facets);
	renderWho();
	renderNumbers();
	renderTime();
	renderTabs();

	renderBreakdown('levels', LEVEL_ORDER, profile.levels,
		key => ({ name: facets.levelNames[key].name, className: `level--${facets.levelNames[key].key}` }),
		key => `/?levels=${key}&hidePlayed=0`);

	// Здесь стоит вопрос «сколько паков какого типа сыграно», и отвечает на него
	// packName — «Аниме-пак», а не «Аниме» (то же правило, что в web/app.js)
	renderBreakdown('topics', TOPIC_ORDER, profile.topics,
		key => ({ name: topicInfo(key).packName, iconNode: topicIcon(key), className: `topic--${key}` }),
		key => `/?topic=${encodeURIComponent(key)}&hidePlayed=0`);

	renderAuthors();
	renderBlacklist();
	renderPlanned();
	renderLibrary();
}

// Имя и аватар ставятся дважды: сразу — из localStorage, чтобы страница не начиналась
// с пустой шапки, и ещё раз в refresh(), когда станет известно, вошёл ли кто-нибудь
renderWho();
bindWho();
bindTabs();
bindList();
bindTopbarSearch();
renderTabs();
refresh();
