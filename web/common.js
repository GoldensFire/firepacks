// Мелочи, которые нужны и библиотеке, и профилю. Отдельный файл, потому что
// иначе они разъезжаются: у страниц разные списки паков, но одни и те же числа,
// склонения и обложки, и расходиться в них они не должны.

'use strict';

const $ = id => document.getElementById(id);

function element(tag, className, text) {
	const node = document.createElement(tag);

	if (className) {
		node.className = className;
	}

	if (text !== undefined && text !== null) {
		node.textContent = text;
	}

	return node;
}

/** Русское склонение по числу: 1 игра, 2 игры, 5 игр. */
function plural(count, one, few, many) {
	const mod10 = count % 10;
	const mod100 = count % 100;

	if (mod10 === 1 && mod100 !== 11) {
		return one;
	}

	if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) {
		return few;
	}

	return many;
}

/**
 * Разряды у больших чисел: 12 480 читается, 12480 — уже нет.
 * Разделитель неразрывный: иначе число переносится по строкам ровно там,
 * где его удобнее всего прочитать неправильно.
 */
function formatNumber(value) {
	return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function formatSize(bytes) {
	if (!bytes) {
		return null;
	}

	const mb = bytes / 1024 / 1024;
	return mb >= 1024 ? `${(mb / 1024).toFixed(1)} ГБ` : `${Math.round(mb)} МБ`;
}

/**
 * Секунды словами: «38 с», «1:20», «12:04».
 *
 * До минуты — числом с буквой, дальше — двоеточием. Это не прихоть: «95 с»
 * читатель всё равно делит в уме, а «1:35» уже поделено. Обратно же —
 * «0:38» вместо «38 с» — писать не стоит: ноль впереди заставляет искать
 * минуты там, где их нет.
 */
function formatSeconds(value) {
	const total = Math.round(value);

	if (total < 60) {
		return `${total} с`;
	}

	return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Ссылки в описании пака. В обсуждении их пишут часто — на вторую часть пака,
 * на автора, на исходники картинок, — а на карточке они лежали простым текстом,
 * и добраться по ним можно было только выделив адрес и скопировав его руками.
 *
 * Разбирается и голый vk.ru/… без «https://»: в обсуждении так пишут чаще всего.
 * Хвостовые знаки препинания в адрес не попадают — точка в конце предложения
 * стоит после ссылки, а не внутри неё.
 */
const LINK_PATTERN = /(https?:\/\/[^\s<>()]+|(?:www\.|vk\.(?:com|ru)\/)[^\s<>()]+)/gi;

function appendLinked(node, source) {
	const text = String(source ?? '');
	let last = 0;

	for (const match of text.matchAll(LINK_PATTERN)) {
		const found = match[0].replace(/[.,;:!?»"'\]]+$/, '');

		if (match.index > last) {
			node.append(document.createTextNode(text.slice(last, match.index)));
		}

		const link = element('a', 'description__link', found);
		link.href = /^https?:\/\//i.test(found) ? found : `https://${found}`;
		link.target = '_blank';
		link.rel = 'noreferrer noopener';
		link.title = link.href;
		node.append(link);

		last = match.index + found.length;
	}

	if (last < text.length) {
		node.append(document.createTextNode(text.slice(last)));
	}

	return node;
}

/**
 * Обложка пака, а если её нет — квадрат с первой буквой названия.
 *
 * Порядок здесь не случаен: loading и размеры ставятся ДО src. Браузер решает
 * судьбу картинки в тот момент, когда ей назначают адрес, и атрибуты, дописанные
 * следом, на это решение уже не влияют — с обратным порядком обложки повисали
 * незагруженными. Размеры проставлены теми же числами, что стоят в стилях: без
 * них страница на месте каждой обложки сначала держит нулевую высоту, и весь
 * список дёргается, пока они грузятся.
 */
function createLogo(pack) {
	if (pack.logo) {
		const image = element('img', 'logo');
		image.loading = 'lazy';
		image.decoding = 'async';
		image.width = 72;
		image.height = 72;
		image.alt = '';
		image.addEventListener('error', () => image.replaceWith(createLogoStub(pack)));
		image.src = pack.logo;
		return image;
	}

	return createLogoStub(pack);
}

function createLogoStub(pack) {
	const letter = (pack.name ?? pack.fileName ?? '?').trim().charAt(0).toUpperCase();
	return element('div', 'logo logo--stub', letter || '?');
}

/**
 * Оценка пака: пять звёзд, половинками. Шкала десятибалльная — половина звезды
 * это один балл, как на Шикимори: 5 звёзд = 10, 2.5 звезды = 5.
 *
 * Половинки сделаны не картинками, а одной полосой поверх серых звёзд: ширина
 * заливки в процентах и есть оценка, поэтому «7 из 10» рисуется само собой и не
 * требует ни отдельного набора значков, ни округления до целых звёзд.
 *
 * Наведение показывает, что будет, если нажать; уход мышью возвращает
 * поставленное. Повторное нажатие на ту же оценку снимает её — иначе передумать
 * можно было бы только в сторону другого балла, но не «никак».
 *
 * Оценивать можно не всё подряд: пак должен быть отмечен сыгранным. Иначе это
 * оценка обложки и описания, а не игры, — и звёзды набирал бы тот пак, у кого
 * заманчивее название. Почему именно нельзя, говорит reason: молчащие звёзды,
 * которые просто не нажимаются, выглядят поломкой.
 *
 * @param {object} pack пак с полем rating: {count, average, mine}
 * @param {object} options
 *   canRate — можно ли оценивать (вошёл ли человек и отмечен ли пак сыгранным)
 *   reason — почему нельзя, если нельзя
 *   minRatings — со скольких оценок показывается средний балл
 *   onRate — (score) => Promise<{count, average, mine}>; 0 значит «снять оценку»
 */
function createRating(pack, options) {
	const { canRate, minRatings, onRate, reason } = options;
	const box = element('div', canRate ? 'rating' : 'rating rating--locked');

	const stars = element('div', 'rating__stars');
	stars.setAttribute('role', canRate ? 'slider' : 'img');

	const track = element('div', 'rating__track', '★★★★★');
	const fill = element('div', 'rating__fill', '★★★★★');
	stars.append(track, fill);

	const value = element('span', 'rating__value');
	const note = element('span', 'rating__note');
	box.append(stars, value, note);

	let state = { ...pack.rating };
	let preview = null;

	/** Что рисовать: наведённая оценка, своя, а иначе — средняя по всем. */
	const shown = () => preview ?? state.mine ?? state.average ?? 0;

	const render = () => {
		const score = shown();
		fill.style.width = `${(score / 10) * 100}%`;
		fill.classList.toggle('rating__fill--mine', preview === null && state.mine !== null);
		stars.classList.toggle('rating__stars--preview', preview !== null);

		if (canRate) {
			stars.setAttribute('aria-valuenow', String(state.mine ?? 0));
			stars.setAttribute('aria-valuemin', '0');
			stars.setAttribute('aria-valuemax', '10');
		}

		stars.setAttribute('aria-label', state.mine !== null
			? `Ваша оценка: ${state.mine} из 10`
			: state.average !== null ? `Средняя оценка: ${state.average} из 10` : 'Оценок пока нет');

		// Балл показывается только с порога: по двум-трём оценкам среднее
		// случайно, а показанное число живёт своей жизнью и запоминается
		if (state.average !== null) {
			value.textContent = state.average.toFixed(1);
			value.className = 'rating__value rating__value--known';
			note.textContent = `${state.count} ${plural(state.count, 'оценка', 'оценки', 'оценок')}`;
		} else {
			value.textContent = '—';
			value.className = 'rating__value';
			// «Нет оценок» на карточке не пишется. Оценок нет у большинства паков,
			// и строка эта стояла в выдаче на каждом втором — повторяя прочерк
			// рядом с ней теми же словами, только длиннее. Прочерк на месте
			// и говорит ровно то же самое, а подсказка у звёзд объясняет, откуда
			// он берётся. Пишется только то, чего по прочерку не видно: сколько
			// оценок уже есть и сколько нужно, чтобы появился балл.
			note.textContent = state.count > 0 ? `${state.count} из ${minRatings} оценок` : '';
		}

		// Своя оценка приписывается к тому, что уже написано, — а написано может
		// быть и ничего: у пака без оценок подпись пуста, и точка-разделитель
		// в начале строки читалась бы обрывком
		if (state.mine !== null) {
			note.textContent = note.textContent
				? `${note.textContent} · ваша ${state.mine}`
				: `ваша ${state.mine}`;
		}

		box.title = state.average !== null
			? `Средняя оценка игроков: ${state.average} из 10 по ${state.count} ${plural(state.count, 'оценке', 'оценкам', 'оценкам')}`
			: `Средний балл появляется, когда пак оценят ${minRatings} раз. Сейчас оценок: ${state.count}`;
	};

	if (canRate) {
		stars.classList.add('rating__stars--active');
		stars.tabIndex = 0;

		// Полшага звезды — один балл: делим ширину на десять, а не на пять
		const scoreAt = event => {
			const rect = stars.getBoundingClientRect();
			const ratio = (event.clientX - rect.left) / rect.width;
			return Math.min(10, Math.max(1, Math.ceil(ratio * 10)));
		};

		stars.addEventListener('mousemove', event => {
			preview = scoreAt(event);
			render();
		});

		stars.addEventListener('mouseleave', () => {
			preview = null;
			render();
		});

		stars.addEventListener('click', async event => {
			const picked = scoreAt(event);
			// Нажатие на уже поставленную оценку снимает её
			const score = picked === state.mine ? 0 : picked;

			preview = null;
			stars.classList.add('rating__stars--saving');

			try {
				state = await onRate(score);
				render();
			} finally {
				stars.classList.remove('rating__stars--saving');
			}
		});

		stars.addEventListener('keydown', async event => {
			const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;

			if (step === 0) {
				return;
			}

			event.preventDefault();
			const next = Math.min(10, Math.max(0, (state.mine ?? 0) + step));
			state = await onRate(next);
			render();
		});
	} else {
		stars.title = reason ?? 'Оценивать паки можно, войдя через Discord';
	}

	render();
	return box;
}

/**
 * Вошедший в шапке: значок и имя одной кнопкой, ведущей в профиль.
 *
 * Раньше это были два отдельных куска — картинка и текст рядом с ней, — и ни один
 * никуда не вёл: в профиль ходили соседней ссылкой «Профиль». Целиться в своё имя
 * при этом пробовали все, и попадание в него не делало ровно ничего. Теперь
 * значок с именем — одна мишень, и промахнуться мимо неё между ними нельзя.
 *
 * Зовётся из тех страниц, где уголок входа рисуется сам (см. renderAccount
 * в app.js и pack.js): вёрстка у него везде одна, и расходиться ей незачем.
 *
 * @param {object} account вошедший: имя и, если есть, значок
 */
function createAccountLink(account) {
	const link = element('a', 'account__user');
	link.href = '/profile';
	link.title = `Профиль: отметки, оценки и чёрный список ${account.name}`;

	if (account.avatar) {
		const avatar = element('img', 'account__avatar');
		avatar.src = account.avatar;
		avatar.alt = '';
		avatar.width = 24;
		avatar.height = 24;
		link.append(avatar);
	}

	link.append(element('span', 'account__name', account.name));
	return link;
}

// ————— страницы —————
//
// Разбивка на страницы нужна и библиотеке, и профилю: списки там и там на сотни
// паков длиной, и приезжают они по две дюжины за раз. Кнопки под выдачей поэтому
// живут здесь, а не в скрипте одной из страниц: расходиться им незачем, а разойтись
// они успели бы на первой же правке.

/**
 * Кнопки страниц под списком.
 *
 * @param {HTMLElement} container куда рисовать
 * @param {object} options
 *   page — какая страница открыта, pageSize — по сколько на ней, total — всего
 *   onGo — (page) => void: сходить за другой страницей
 */
function renderPages(container, { page, pageSize, total, onGo }) {
	container.textContent = '';

	const pageCount = Math.ceil(total / pageSize);

	if (pageCount <= 1) {
		return;
	}

	const go = target => {
		onGo(target);
		window.scrollTo({ top: 0, behavior: 'smooth' });
	};

	const addButton = (label, target, disabled, current) => {
		const button = element('button', null, label);
		button.type = 'button';
		button.disabled = !!disabled;

		if (current) {
			button.setAttribute('aria-current', 'true');
		}

		if (!disabled && !current) {
			button.addEventListener('click', () => go(target));
		}

		container.append(button);
	};

	addButton('‹', page - 1, page === 1);

	const pages = new Set([1, pageCount, page]);

	for (let offset = 1; offset <= 2; offset++) {
		pages.add(page - offset);
		pages.add(page + offset);
	}

	const visible = [...pages].filter(p => p >= 1 && p <= pageCount).sort((a, b) => a - b);
	let previous = 0;

	for (const number of visible) {
		if (number - previous > 1) {
			const gap = element('button', null, '…');
			gap.disabled = true;
			container.append(gap);
		}

		addButton(String(number), number, false, number === page);
		previous = number;
	}

	addButton('›', page + 1, page === pageCount);

	// Многоточие между кнопками — это не только пропуск, но и тупик: со страницы
	// второй на сороковую приходилось идти вручную, по пять номеров за нажатие,
	// потому что кнопки показывают только соседей. Поле рядом с ними эту дорогу
	// и сокращает: номер — и сразу туда.
	//
	// Заводится только там, где ему есть что делать: на трёх страницах номера
	// и так все на виду.
	if (pageCount > 5) {
		container.append(createPageJump(page, pageCount, go));
	}
}

/** Поле «перейти к странице»: номер и переход по Enter или по кнопке. */
function createPageJump(page, pageCount, go) {
	const box = element('form', 'pager__jump');

	const input = element('input', 'pager__jump-input');
	input.type = 'number';
	input.min = '1';
	input.max = String(pageCount);
	input.step = '1';
	input.inputMode = 'numeric';
	input.placeholder = String(page);
	input.setAttribute('aria-label', `Перейти к странице от 1 до ${pageCount}`);
	input.title = `Введите номер страницы от 1 до ${pageCount}`;

	const jump = element('button', 'pager__jump-go', 'Перейти');
	jump.type = 'submit';
	jump.title = 'Открыть страницу с этим номером';

	box.append(element('span', 'pager__jump-label', `из ${pageCount}:`), input, jump);

	box.addEventListener('submit', event => {
		// Форма здесь ради одного только Enter: без неё нажатие Enter в поле
		// не значило бы ничего, а тянуться мышью до кнопки ради номера страницы —
		// ровно та работа, от которой поле и избавляет.
		event.preventDefault();

		const asked = parseInt(input.value, 10);

		if (!Number.isFinite(asked)) {
			return;
		}

		// Номер за пределами списка прижимаем к краю, а не отвергаем: «999»
		// в поле означает «в самый конец», и отвечать на это молчанием незачем.
		const target = Math.min(Math.max(asked, 1), pageCount);

		input.value = '';

		if (target !== page) {
			go(target);
		}
	});

	return box;
}

// ————— шапка —————
//
// Шапка одна на весь сайт и на всех страницах одинакова — вплоть до поля поиска
// и счётчиков. Раньше она у каждой страницы была своя: в библиотеке с поиском,
// на топах без него, в профиле ещё и без уголка входа, — и при переходе между
// страницами верхняя строка перекладывалась заново, будто это разные сайты.
// Ссылка на текущую страницу из неё при этом не убирается: пропадающий пункт
// сдвигает соседние, и целиться в них приходится каждый раз заново.
//
// Вёрстка у шапки общая (см. любой из web/*.html), а наполняет её это.

/**
 * Поиск из шапки на любой странице, кроме самой библиотеки: там он ищет на месте
 * (см. web/app.js), здесь — уводит в библиотеку с уже набранным запросом.
 */
function bindTopbarSearch() {
	const form = $('searchBox');

	if (!form) {
		return;
	}

	form.addEventListener('submit', event => {
		event.preventDefault();

		const text = $('search').value.trim();
		window.location.href = text ? `/?search=${encodeURIComponent(text)}` : '/';
	});
}

// ————— тема —————
//
// Тем две, и живут они одним набором цветов: правило :root[data-theme="light"]
// в style.css переставляет значения тех же самых имён, а вся вёрстка написана
// через них (см. пояснение к :root там же). Отсюда и весь здешний код — три
// строки: поставить метку на страницу, запомнить выбор, переписать подпись
// у кнопки. Ни одного цвета скрипт не знает и знать не должен.
//
// Метку ставит не этот файл, а крохотный скрипт в самой шапке каждой страницы:
// он выполняется до первой отрисовки, и потому светлая тема не моргает тёмной.
// Здесь остаётся нажатие.

/** Где лежит выбор. Тот же ключ читает скрипт в шапке страниц. */
const THEME_KEY = 'firepacks.theme';

/**
 * Поставить тему: метка на странице, запись в браузере и подпись у кнопки.
 *
 * Подпись говорит, что будет по нажатию, а не что стоит сейчас: кнопки сайта
 * везде подписаны будущим («Запланировать», а не «не запланировано»), и эта
 * не должна быть исключением. Значок меняется сам, правилом по метке.
 *
 * @param {'light'|'dark'} theme какую включить
 * @param {boolean} remember запоминать ли выбор (при первом показе — нет)
 */
function applyTheme(theme, remember) {
	const light = theme === 'light';

	// Тёмная — та, что по умолчанию, и метки ей не нужно: без метки страница
	// и так тёмная. Снятая метка вместо «data-theme=dark» заодно означает,
	// что правил для тёмной темы писать не пришлось ни одного.
	if (light) {
		document.documentElement.dataset.theme = 'light';
	} else {
		delete document.documentElement.dataset.theme;
	}

	if (remember) {
		try {
			localStorage.setItem(THEME_KEY, light ? 'light' : 'dark');
		} catch (error) {
			// Хранилище запрещено настройками браузера: тема тогда держится
			// до закрытия вкладки, и это всё, что здесь можно сделать
		}
	}

	const button = $('themeToggle');

	if (button) {
		button.title = light ? 'Тёмная тема' : 'Светлая тема';
		button.setAttribute('aria-label', light ? 'Включить тёмную тему' : 'Включить светлую тему');
	}
}

/** Нынешняя тема — по метке на странице, которую поставил скрипт в её шапке. */
const currentTheme = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

/**
 * Кнопка переключения темы в шапке. Зовётся сразу, при загрузке этого файла,
 * а не из initTopbar: остальная шапка ждёт ответа /api/facets, а теме ждать
 * нечего — она целиком в самом браузере, и работать кнопка должна с первого мига.
 */
function bindThemeToggle() {
	const button = $('themeToggle');

	if (!button) {
		return;
	}

	// Первый заход — только подпись: тему уже поставил скрипт в шапке страницы,
	// и переписывать её в хранилище незачем. Выбор туда кладёт нажатие, и только
	// оно: иначе всякое открытие сайта записывало бы «тёмная» тому, кто ничего
	// не выбирал, — и появись однажды тема по настройкам системы, она бы уже
	// не сработала ни у кого.
	applyTheme(currentTheme(), false);

	button.addEventListener('click', () => {
		applyTheme(currentTheme() === 'light' ? 'dark' : 'light', true);
	});
}

bindThemeToggle();

/**
 * Шапка сама по себе — страницам, которым настройки больше ни за чем не нужны
 * (топ авторов, обновление базы). Остальные зовут renderTopbar тем же ответом
 * /api/facets, за которым идут и так: второй такой же запрос ради одних
 * счётчиков был бы платой ни за что.
 */
async function initTopbar() {
	bindTopbarSearch();
	renderTopbar(await (await fetch('/api/facets')).json());
}

/**
 * Счётчики, уголок входа и ссылка на обновление базы. Всё, что шапке нужно
 * знать, лежит в ответе /api/facets — его и ждём.
 *
 * @param {object} facets ответ /api/facets вместе с полем user
 */
function renderTopbar(facets) {
	renderTopbarCounters(facets);
	renderTopbarAccount(facets);

	// На хостинге собирать базу нечем, и ссылки на страницу обновления там быть
	// не должно: обновлять самого себя оттуда некуда и нечем.
	//
	// В вёрстке она спрятана, и здесь только показывается — не наоборот. Стой она
	// открытой, на общем сайте «Обновить базу» мигало бы у каждого, кто открыл
	// страницу, всё время, пока идёт первый запрос.
	const update = $('updateLink');

	if (update) {
		if (facets.readOnly) {
			update.remove();
		} else {
			update.hidden = false;
		}
	}
}

/**
 * Счётчики в шапке. Разделены не точками, а промежутком: точку между «Паков: 11 480»
 * и «Сыграно: 12» глаз читает как знак препинания внутри одного предложения, хотя
 * это отдельные числа про разное. Промежуток держит сама строка (см. .counters
 * в style.css) — оттого каждый счётчик и стоит отдельным элементом, а не куском
 * одной строки.
 */
function renderTopbarCounters(facets) {
	const box = $('counters');

	if (!box) {
		return;
	}

	// Без входа сыгранное считается по отметкам самого браузера: сервер о них
	// не знает и присылает ноль, а на счётчике должно стоять то же число, что
	// человек видит на карточках
	const onServer = Boolean(facets.user) || facets.localBlacklist === true;
	const played = onServer ? facets.played : localPlayed.size;
	const planned = onServer ? (facets.planned ?? 0) : localPlanned.size;

	box.textContent = '';

	// Все три счётчика — ссылки на те списки, о которых они говорят: «Паков» —
	// на библиотеку целиком, «Сыграно» и «В планах» — в профиль, сразу на нужную
	// вкладку. Целиться в число пробуют во всех трёх одинаково, и раньше два
	// из них нажимались, а первое молчало — притом что стоит оно первым и говорит
	// про самый очевидный список из всех.
	const addLink = (label, value, href, title) => {
		const item = element('a', 'counters__item counters__item--link', `${label}: `);
		item.href = href;
		item.title = title;
		item.append(element('b', null, formatNumber(value)));
		box.append(item);
	};

	// Адрес голый, без единого отбора: «Паков: 11 480» — это про всю базу,
	// и открываться по нему должна вся база, а не то, что отобрано сейчас
	addLink('Паков', facets.total, '/', 'Открыть библиотеку: все паки');
	addLink('Сыграно', played, '/profile?tab=played', 'Перейти в профиль: сыграно');

	// Запланированное показывается, только когда оно есть: пустой счётчик
	// в шапке — это строка про то, чего человек ни разу не делал
	if (planned > 0) {
		addLink('В планах', planned, '/profile?tab=planned', 'Перейти в профиль: в планах');
	}
}

/**
 * Уголок входа. Пока ключи Discord не заведены, вместо кнопки стоит пояснение:
 * кнопка, ведущая в «вход не настроен», хуже её отсутствия, но и молчание
 * оставляло сайт без ответа на вопрос «почему я не могу поставить оценку».
 */
function renderTopbarAccount(facets) {
	const box = $('account');

	if (!box) {
		return;
	}

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

	if (!facets.user) {
		const login = element('a', 'button button--discord', 'Войти через Discord');
		login.href = '/auth/discord';
		login.title = 'Оценки паков и личный чёрный список появляются после входа';
		box.append(login);
		return;
	}

	// «Выйти» здесь больше нет: это действие теперь живёт на самой странице
	// профиля, у имени и аватара (см. renderWho в web/profile.js), а не в шапке,
	// которая одна на весь сайт и есть на каждой странице
	box.append(createAccountLink(facets.user));
}

/** Ссылка «Играть» на официальный движок с уже подставленным паком. */
function createPlayLink(pack, playerUri) {
	const play = element('a', 'button button--primary', 'Играть');
	play.href = `${playerUri}?packageUri=${encodeURIComponent(pack.url)}&packageName=${encodeURIComponent(pack.name ?? '')}`;
	play.target = '_blank';
	play.rel = 'noreferrer noopener';
	return play;
}

/**
 * Хранит ли отметки «сыграно» сервер. Дома хозяин отметки — сама установка,
 * и отмечать можно без входа; на общем сайте хозяина без входа нет, и отметка
 * одного человека зажигалась бы у всех сразу.
 *
 * Опирается на общие для всех страниц `user` и `facets`: их заводит скрипт
 * самой страницы (см. card.js и profile.js), а спрашивать их приходится и там,
 * и там.
 */
const serverMarks = () => Boolean(user) || facets?.localBlacklist === true;

// ————— отметки «сыграно» без входа —————
//
// Раньше кнопка «Отметить сыгранным» на общем сайте просто не нажималась, и это
// выглядело придиркой: человек честно сыграл пак и хочет это где-то отметить,
// а сайт отвечает «сначала заведите учётную запись». Хранить-то отметку и правда
// негде — но негде на СЕРВЕРЕ, а браузер помнит не хуже.
//
// Поэтому до входа отметки живут прямо здесь, в самом браузере. Живут честно:
// это тот же список, только он знает про один этот браузер, и об этом кнопка
// прямо говорит. А в тот миг, когда человек всё же входит, весь список разом
// переезжает в учётную запись (см. uploadLocalPlayed) — ничего не теряется,
// и заново отмечать сыгранное не приходится.
//
// Паки помнятся по общему ключу, а не по номеру строки: номера меняются при
// каждой заливке базы, ключ считается из самого файла (см. src/keys.js).

const LOCAL_PLAYED_KEY = 'firepacks.played';

/** Отметки этого браузера. Пустое множество, пока сайтом не пользовались. */
let localPlayed = new Set();

function loadLocalPlayed() {
	try {
		const saved = JSON.parse(window.localStorage.getItem(LOCAL_PLAYED_KEY) ?? '[]');
		localPlayed = new Set(Array.isArray(saved) ? saved.filter(key => typeof key === 'string') : []);
	} catch {
		// Хранилище может быть закрыто настройками браузера — тогда отметок
		// просто не будет, и это не повод ронять всю страницу
		localPlayed = new Set();
	}
}

function saveLocalPlayed() {
	try {
		window.localStorage.setItem(LOCAL_PLAYED_KEY, JSON.stringify([...localPlayed]));
	} catch {
		// Некуда сохранять — отметка проживёт до обновления страницы
	}
}

/** Отмечен ли пак сыгранным: сервером или этим браузером. */
const isPlayed = pack => pack.played || localPlayed.has(pack.packKey);

/**
 * Переносит отметки браузера в учётную запись. Вызывается один раз при загрузке
 * страницы вошедшим: пока хозяина не было, отметки копились здесь, и первое, что
 * человек ждёт после входа, — увидеть их на месте.
 */
async function uploadLocalPlayed() {
	if (localPlayed.size === 0) {
		return;
	}

	const keys = [...localPlayed];

	const response = await fetch('/api/played', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ packKeys: keys, played: true }),
	});

	const result = await response.json().catch(() => ({ error: 'не удалось' }));

	if (result.error) {
		// Не вышло — список остаётся в браузере и попробует переехать в другой раз
		return;
	}

	localPlayed.clear();
	saveLocalPlayed();
}

// ————— запланированное —————
//
// «Отметить сыгранным» отвечает на вопрос про прошлое, а перед игрой стоит другой:
// вот пак, играть в него сегодня некогда, но сесть за него хочется — и запомнить
// это было негде. Приходилось либо держать название в голове, либо складывать
// ссылки в заметки на стороне.
//
// Устроено ровно как «сыграно», вплоть до жизни в браузере до входа: это тот же
// список отметок, только про будущее. Пак бывает и сыгранным, и запланированным
// сразу — сыграли, хотим ещё раз, — поэтому список свой, а не признак у того.

const LOCAL_PLANNED_KEY = 'firepacks.planned';

let localPlanned = new Set();

function loadLocalPlanned() {
	try {
		const saved = JSON.parse(window.localStorage.getItem(LOCAL_PLANNED_KEY) ?? '[]');
		localPlanned = new Set(Array.isArray(saved) ? saved.filter(key => typeof key === 'string') : []);
	} catch {
		localPlanned = new Set();
	}
}

function saveLocalPlanned() {
	try {
		window.localStorage.setItem(LOCAL_PLANNED_KEY, JSON.stringify([...localPlanned]));
	} catch {
		// Некуда сохранять — отметка проживёт до обновления страницы
	}
}

/** Отобран ли пак на будущее: сервером или этим браузером. */
const isPlanned = pack => pack.planned || localPlanned.has(pack.packKey);

/** Переносит запланированное браузера в учётную запись — вместе с сыгранным. */
async function uploadLocalPlanned() {
	if (localPlanned.size === 0) {
		return;
	}

	const response = await fetch('/api/planned', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ packKeys: [...localPlanned], planned: true }),
	});

	const result = await response.json().catch(() => ({ error: 'не удалось' }));

	if (result.error) {
		return;
	}

	localPlanned.clear();
	saveLocalPlanned();
}

/** Обе стопки местных отметок разом: их читают и переносят всегда вместе. */
function loadLocalMarks() {
	loadLocalPlayed();
	loadLocalPlanned();
}

const localMarks = () => localPlayed.size + localPlanned.size;

async function uploadLocalMarks() {
	await Promise.all([uploadLocalPlayed(), uploadLocalPlanned()]);
}
