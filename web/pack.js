// Отдельная страница пака: /pack/128-anime-pak.
//
// Зачем она есть. У пака до сих пор не было своего адреса: он жил карточкой
// в выдаче, и «смотри какой пак» приходилось пересказывать названием, а поисковику
// нечего было показать в ответ на «пак по Гарри Поттеру» — вся библиотека
// отвечала одной страницей. Теперь у каждого пака своя, и ведут на неё название
// с обложкой в выдаче, кнопка «поделиться» и карта сайта.
//
// Своей вёрстки у страницы почти нет: пак рисует та же самая карточка, что
// и в библиотеке (см. card.js), только развёрнутая — название становится
// заголовком, описание не сворачивается, состав раундов раскрыт сразу.
// Второго описания пака на сайте быть не должно: они разъедутся.

'use strict';

/** Номер пака из адреса. То, что после номера, — название для человека, и оно не важно. */
function packIdFromPath() {
	const found = /^\/pack\/(\d+)/.exec(window.location.pathname);
	return found ? found[1] : null;
}

/**
 * Нажали на автора, тип пака, тему или повтор. Отбирать здесь нечего — пак
 * на странице один, — поэтому вопрос «покажи такие же» уводит в библиотеку,
 * которая читает фильтры прямо из адреса (см. readUrlState в app.js).
 */
function pickFilter(kind, value) {
	const names = { author: 'author', topic: 'topic', tag: 'tag', franchise: 'franchise', subject: 'subject' };
	window.location.href = `/?${names[kind]}=${encodeURIComponent(value)}`;
}

/** Отметки на этой странице ничего за пределами карточки не меняют. */
function onPlayedChange() {}
function onPlannedChange() {}

/**
 * Уголок входа. Тот же, что в библиотеке, но короче: заводить здесь пояснения
 * про ненастроенный Discord незачем — за этим приходят на главную.
 */
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

/** Пака нет: номер выдуман, пак спрятан или уехал из базы. */
function renderMissing() {
	const box = $('pack');
	box.textContent = '';

	const empty = element('div', 'empty');
	empty.append(document.createTextNode('Такого пака нет. Возможно, он уехал из базы или ссылка набрана с ошибкой. '));

	const back = element('a', null, 'Вернуться в библиотеку');
	back.href = '/';
	empty.append(back);

	box.append(empty);
	document.title = 'Пак не найден — FirePacks';
}

async function start() {
	const id = packIdFromPath();

	loadLocalMarks();

	// Обе ходки уходят разом: пак не зависит от настроек, а настройки — от пака
	const [facetsResponse, packResponse] = await Promise.all([
		fetch('/api/facets'),
		fetch(`/api/package?id=${encodeURIComponent(id ?? '')}`),
	]);

	facets = await facetsResponse.json();
	user = facets.user ?? null;

	renderAccount();

	const data = await packResponse.json();

	if (!data.package) {
		renderMissing();
		return;
	}

	const pack = data.package;

	// Отметки, сделанные до входа, переезжают в учётную запись там же, где и в
	// библиотеке: человек мог войти прямо отсюда, и первое, что он ждёт увидеть, —
	// свою отметку на месте
	if (serverMarks() && localMarks() > 0) {
		await uploadLocalMarks();
	}

	const box = $('pack');
	box.textContent = '';

	const card = createCard(pack, { standalone: true });
	shownCards = [{ pack, card }];
	box.append(card);

	// Адрес мог быть набран без названия или с устаревшим (пак переименовали):
	// поправляем его на нынешний, не перезагружая страницу. Ссылка, которой человек
	// поделился вчера, при этом продолжает работать — открывает пак по номеру.
	const proper = pack.slug ? `/pack/${pack.id}-${pack.slug}` : `/pack/${pack.id}`;

	if (window.location.pathname !== proper) {
		window.history.replaceState({}, '', proper + window.location.search);
	}
}

start();
