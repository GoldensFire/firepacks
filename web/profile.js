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
const TOPIC_ORDER = ['mixed', 'anime', 'games', 'movies', 'cartoons', 'books', 'music', 'unknown'];

const EXTRA_TOPICS = {
	mixed: { name: 'Солянка', packName: 'Солянка' },
	unknown: { name: 'Без разметки', packName: 'Без разметки' },
};

/** Как человек себя назвал. Ничего, кроме подписи, за этим именем не стоит. */
const NAME_KEY = 'firepacks.profile.name';

let facets = null;
let profile = null;

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
	const account = $('account');

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

			await start();
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

	const planned = profile.planned?.length ?? 0;

	// Пустого «0 паков в планах» здесь нет: это число про то, чего человек
	// ни разу не делал, а объясняет это сам список ниже
	if (planned > 0) {
		add(formatNumber(planned), plural(planned, 'пак в планах', 'пака в планах', 'паков в планах'),
			'Отложено на будущее — список ниже');
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
		chip.href = `/?author=${encodeURIComponent(author.name)}`;
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

		await start();
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
function renderPlanned() {
	const grid = $('plannedGrid');
	const packs = profile.planned ?? [];

	grid.textContent = '';

	if (packs.length === 0) {
		const anonymous = !user && facets.localBlacklist !== true;

		grid.append(element('div', 'empty', anonymous
			? 'Здесь собираются паки, отложенные на будущее. Пока входа нет, отметки живут '
				+ 'в самом браузере и сюда не попадают: войдите через Discord — они переедут в учётную запись.'
			: 'Здесь собираются паки, отложенные на будущее. Отложить можно в библиотеке — '
				+ 'кнопкой «Запланировать» на карточке.'));

		$('plannedInfo').textContent = '';
		return;
	}

	for (const pack of packs) {
		grid.append(createCard(pack, { planned: true }));
	}

	const info = $('plannedInfo');
	info.textContent = '';

	info.append(document.createTextNode(`Всего ${packs.length}, сначала отложенные недавно · `));

	// Ссылка в библиотеку с уже выставленным отбором: здесь список целиком,
	// а там по нему можно искать теми же фильтрами, что и по всей базе
	const inLibrary = element('a', null, 'показать в библиотеке');
	inLibrary.href = '/?onlyPlanned=1';
	info.append(inLibrary);
}

function renderLibrary() {
	const grid = $('grid');
	grid.textContent = '';

	if (profile.packages.length === 0) {
		// Без входа отметки лежат в самом браузере и до профиля не доходят: он
		// показывает то, что знает сервер. Сказать об этом надо здесь — иначе
		// человек, отметивший вчера десяток паков, решит, что они пропали.
		const anonymous = !user && facets.localBlacklist !== true;

		grid.append(element('div', 'empty', anonymous
			? 'Здесь появятся паки, отмеченные сыгранными. Пока входа нет, отметки живут '
				+ 'в самом браузере и сюда не попадают: войдите через Discord — они переедут в учётную запись.'
			: 'Здесь появятся паки, отмеченные сыгранными. Отметить можно в библиотеке — кнопкой на карточке.'));

		$('resultInfo').textContent = '';
		return;
	}

	for (const pack of profile.packages) {
		grid.append(createCard(pack));
	}

	$('resultInfo').textContent = `Всего ${profile.packages.length}, сначала недавние`;
}

async function start() {
	[facets, profile] = await Promise.all([
		fetch('/api/facets').then(r => r.json()),
		fetch('/api/profile').then(r => r.json()),
	]);

	user = facets.user ?? null;

	renderWho();
	renderNumbers();

	renderBreakdown('levels', LEVEL_ORDER, profile.levels,
		key => ({ name: facets.levelNames[key].name, className: `level--${facets.levelNames[key].key}` }),
		key => `/?levels=${key}`);

	// Здесь стоит вопрос «сколько паков какого типа сыграно», и отвечает на него
	// packName — «Аниме-пак», а не «Аниме» (то же правило, что в web/app.js)
	renderBreakdown('topics', TOPIC_ORDER, profile.topics,
		key => ({ name: topicInfo(key).packName, iconNode: topicIcon(key), className: `topic--${key}` }),
		key => `/?topic=${encodeURIComponent(key)}`);

	renderAuthors();
	renderBlacklist();
	renderPlanned();
	renderLibrary();
}

// Имя и аватар ставятся дважды: сразу — из localStorage, чтобы страница не начиналась
// с пустой шапки, и ещё раз в start(), когда станет известно, вошёл ли кто-нибудь
renderWho();
bindWho();
start();
