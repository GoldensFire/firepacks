// Карточка пака: всё, что сайт рисует про один пак.
//
// Вынесено из web/app.js по той же причине, по какой оттуда когда-то вынесли
// common.js: у пака теперь есть своя страница (/pack/…), и показывает она тот же
// самый пак. Разойдись эти два описания — и полоски долей, ярлыки и подсказки
// на странице пака начали бы врать по сравнению с выдачей библиотеки.
//
// Отличий у двух мест ровно два, и решает их не этот файл, а сама страница:
//
//   pickFilter(kind, value) — что делать при нажатии на автора, тип пака, тему
//     или повтор. Библиотека меняет фильтры на месте, страница пака уходит
//     ссылкой в библиотеку;
//   onPlayedChange(pack) — что делать после отметки «сыграно»: библиотеке надо
//     пересчитать счётчик в шапке и, если сыгранное спрятано, обновить выдачу,
//     странице пака — ничего.
//
// Обе функции обязана объявить каждая страница, которая подключает этот файл.

'use strict';

/** Настройки сайта. Ставит их страница, когда ответ /api/facets доедет. */
let facets = null;

/** Кто вошёл. Пока null — оценивать и прятать нельзя, остальное работает. */
let user = null;

/** Категории, которые делят вопросы между собой: их доли складываются в сотню. */
const SHARE_ORDER = ['anime', 'manga', 'games', 'movies', 'cartoons', 'books', 'comics', 'other'];

/**
 * Музыка среди тематик стоит особняком: она не спорит с остальными, а идёт поверх
 * («по музыке это и отгадывают»), и в сотню долей не входит. Ключ вынесен, потому
 * что нужен в двух местах сразу — ярлык музпака и подпись куска «прочее».
 */
const MUSIC_TOPIC = 'music';

/**
 * Из чего сделаны вопросы. Считается разбором самого файла (см. siq.js), и здесь
 * это вторая полоска под названием: она тоже полна ровно на сотню.
 */
const CONTENT_ORDER = ['text', 'image', 'audio', 'video', 'html'];

const CONTENT_NAMES = {
	text: 'Текст',
	image: 'Картинки',
	// Просто «Звук»: полоска отвечает на вопрос «из чего сделаны вопросы», и ответ
	// у неё про вид файла, а не про то, музыка там или лай собаки. Слово «музыка»
	// здесь ещё и спорило с верхней полоской, где оно значит совсем другое —
	// «по музыке эти вопросы и отгадывают».
	audio: 'Звук',
	video: 'Видео',
	html: 'HTML',
};

/** Ярлыки, которых нет в TOPICS: их считает не модель, а порог. */
const EXTRA_TOPICS = {
	mixed: { name: 'Солянка', packName: 'Солянка' },
	unknown: { name: 'Без разметки', packName: 'Без разметки' },
};

const topicInfo = key => facets.topicNames[key] ?? EXTRA_TOPICS[key] ?? { name: key, packName: key };

/** Как называется вид спецвопроса. Имена приходят с сервера вместе с остальными настройками. */
const specialName = key => facets.specialNames?.[key] ?? key;

/**
 * Адрес отдельной страницы пака. Номер решает, какой пак открывать, а название
 * латиницей стоит рядом ради человека и поисковой выдачи — считает его сервер
 * и присылает вместе с паком (см. src/slug.js).
 */
const packHref = pack => pack.slug ? `/pack/${pack.id}-${pack.slug}` : `/pack/${pack.id}`;

/**
 * Чем оказалось «прочее» этого пака: «стримеры, история». Пустая строка значит,
 * что ничего заметного там нет, — тогда «Прочее» так и остаётся прочим.
 *
 * Считает не сайт: доли видов размечены моделью и посчитаны при разборе
 * (см. computeOtherKinds в src/topics.js), сюда приезжает готовый список,
 * из которого выброшено всё мельче порога.
 */
function otherKindsLine(pack) {
	return (pack.otherKinds ?? [])
		.map(kind => facets.otherKindNames?.[kind.key] ?? kind.key)
		.join(', ');
}

/** С большой буквы: имена видов «прочего» хранятся строчными («спорт»). */
const capitalize = text => (text ? text[0].toUpperCase() + text.slice(1) : text);

/**
 * С какой доли самого «прочего» его вид считается тем, чем это «прочее»
 * и является. Три пятых — это уже не «в том числе спорт», а «это и есть спорт».
 */
const DOMINANT_KIND = 0.6;

/**
 * Кусок «прочего» в полоске тематик: как он называется и какого он цвета.
 *
 * «Прочее» — категория честная, но пустая: пять тематик отвечают на вопрос
 * «откуда вопрос», и всё, что не аниме, не игры, не кино, не мультики, не книги
 * и не комиксы, сваливается в общую кучу. У футбольного пака эта куча — почти
 * весь пак, и подпись «Прочее: спорт» серым по серому не говорит ничего.
 *
 * Поэтому кусок называется тем, чем он оказался, и красится в свой цвет
 * (см. shares__part--kind-* в style.css): у футбольного пака полоска зелёная
 * и подписана «Футбол». Имя берётся у предмета пака, когда предмет и есть это
 * «прочее» (совпал по размеру), и у вида — когда предмет шире или его нет вовсе:
 * «Спорт» вместо «Футбола» точнее, чем «Футбол» вместо «Спорта».
 *
 * Когда же прочее и вправду разное, всё остаётся как было: серый кусок
 * и подпись «Прочее: стримеры, история» — перечисление тут и есть ответ.
 */
function otherPart(pack) {
	const value = pack.topicShares?.other ?? 0;
	const plain = { key: 'other', name: topicInfo('other').name, value };

	// У музпака «прочее» — это и есть музыка: песня, которая не из фильма
	// и не из аниме, попадает именно сюда, и у пака, который весь про музыку,
	// полоска говорила «55% Прочее», то есть не говорила ничего. Ярлык пака
	// к этому времени уже посчитан моделью (см. toPrimary в src/topics.js)
	if (pack.primaryTopic === MUSIC_TOPIC) {
		return { key: MUSIC_TOPIC, name: topicInfo(MUSIC_TOPIC).name, value };
	}

	const kinds = pack.otherKinds ?? [];
	const top = kinds[0];

	if (!top) {
		return plain;
	}

	if (top.share < value * DOMINANT_KIND) {
		return { ...plain, name: `${plain.name}: ${otherKindsLine(pack)}` };
	}

	// Предмет пака годится в имя куска, только если он этому куску по размеру:
	// у аниме-пака про «Наруто» с одной футбольной темой предмет — «Наруто»,
	// и подписывать им десять процентов спорта было бы прямым враньём
	const subject = (pack.franchises ?? [])[0];
	const fits = subject && subject.share >= top.share * 0.8 && subject.share <= value * 1.25;

	return {
		key: `kind-${top.key}`,
		name: fits ? subject.name : capitalize(facets.otherKindNames?.[top.key] ?? top.key),
		value,
	};
}

/**
 * Пак про одну вселенную — тот, что целиком, без остатка, состоит из одной
 * тематики и одного произведения: не просто кинопак, а кинопак по Гарри Поттеру.
 *
 * Такому паку ярлык «Кинопак 100%» не говорит ничего: сотня процентов кино —
 * это и так видно по полоске, а вот чего именно кино — нет. Поэтому вселенная
 * встаёт прямо в ярлык, а список повторов у такого пака не показывается вовсе:
 * «Гарри Поттер ×27» — это пересказ того же самого числом.
 *
 * Солянки и «прочее» сюда не попадают нарочно: у них про предмет уже есть свой
 * ярлык-мишень, и он честнее — пак про футбол не становится «Солянкой (Футбол)».
 */
function universeOf(pack) {
	const share = facets.universePackShare ?? 0.9;
	// Вселенная — это произведение: «пак про одну Историю» вселенной не бывает,
	// и такому паку ярлык-мишень подходит больше (см. mostCommon в createBadges)
	const top = (pack.franchises ?? []).find(item => item.kind !== 'area');

	if (!top || top.share < share) {
		return null;
	}

	if (!pack.primaryTopic || pack.primaryTopic === 'mixed' || pack.primaryTopic === 'other') {
		return null;
	}

	return (pack.primaryShare ?? 0) >= share ? top : null;
}

/** Музыкальный ли пак: доля музыкальных вопросов взяла порог. */
function isMusical(pack) {
	return Boolean(pack.primaryTopic) && (pack.topicShares?.music ?? 0) >= facets.musicThreshold;
}

/**
 * Можно ли прятать паки прямо сейчас. Вошедшему — всегда, а без входа только
 * на своей машине: там чёрный список принадлежит установке, как и отметки
 * «сыграно» (сервер говорит об этом в facets.localBlacklist).
 */
const canHide = () => Boolean(user) || facets?.localBlacklist === true;

// Отметки «сыграно» и «в планах» — и то, где они лежат до входа, — переехали
// в common.js: их читает и профиль тоже (см. вывоз списка в файл), а он карточек
// библиотеки не грузит вовсе.

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
	// Повтором не считается то, чем пак и является. У пака про Гарри Поттера
	// «Гарри Поттер ×27» — не наблюдение, а пересказ названия числом: он на то
	// и пак по Гарри Поттеру, чтобы тем про Гарри Поттера в нём было много.
	// Такой предмет уже назван ярлыком в шапке — вселенной («Кинопак (Гарри
	// Поттер)») или мишенью («Гарри Поттер 74%»), — и повторять его списком
	// повторов значит говорить одно и то же дважды.
	//
	// Порог тот же самый, по которому ставится ярлык (subjectPackShare): что
	// на карточке названо предметом пака, то из повторов и уходит. Остальные
	// франшизы при этом остаются — у пака про Гарри Поттера с тремя темами
	// про «Властелина колец» это настоящий повтор, и он единственное, что
	// об этом говорит.
	const own = facets.subjectPackShare ?? 0.5;

	// В том же списке лежат области — «Футбол», «Вторая мировая война», —
	// и повторами они не бывают: викторина вся из них и состоит, а «География ×5»
	// не говорит о паке ничего. Своё место у них есть — ярлык-мишень «Футбол»
	// у пака, который весь про футбол (см. mostCommon в createBadges)
	const franchises = (pack.franchises ?? []).filter(item => item.kind !== 'area' && item.share < own);

	if (franchises.length === 0) {
		return null;
	}

	const box = element('div', 'repeats');

	// Число рядом с подписью — сколько всего тем пака приходится на повторы.
	// Ярлыков в строке бывает с десяток, и «много ли тут повторов» до сих пор
	// приходилось складывать глазами по «×3, ×2, ×2»; теперь это одно число,
	// и по нему паки сравниваются между собой с одного взгляда.
	const total = franchises.reduce((sum, item) => sum + item.themes, 0);

	const title = iconText('repeat', 'Повторы:', 'repeats__title');
	title.append(element('span', 'repeats__total', String(total)));
	title.title = `Повторяющихся тем в паке: ${total} — они приходятся на `
		+ `${franchises.length} ${plural(franchises.length, 'франшизу', 'франшизы', 'франшиз')}`;
	box.append(title);

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

		chip.addEventListener('click', () => pickFilter('franchise', franchise.name));

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
 * На собственной странице пака сворачивать нечего: там этот пак один, и место,
 * которое описание займёт, оно и должно занять.
 */
function createDescription(pack, full) {
	if (!pack.commentText) {
		return null;
	}

	const box = element('div', full ? 'description description--open' : 'description');
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
 * Порядок подписи — это порядок кусков в самой полоске, а не «от большего
 * к меньшему»: подпись и полоска стоят друг под другом и читаются как одно,
 * и когда цвета в них идут вразнобой, точку приходится искать глазами. Двойного
 * упорядочивания тут не нужно вовсе — сама доля написана рядом словами.
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
		.filter(part => part.percent >= 0.5);

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

/**
 * Полоска вместе с её подписью. caption — вопрос, написанный над полоской:
 * он есть только у нижней («Из чего состоит пак?»), потому что к третьей подряд
 * полоске подписи под ней уже мало — читаются они как продолжение верхних.
 */
function createShareRow(parts, className, suffix, title, caption) {
	const bar = createShareBar(parts, className, suffix);

	if (!bar) {
		return null;
	}

	bar.title = title;

	const row = element('div', 'shares__row');

	if (caption) {
		row.append(element('div', 'shares__caption', caption));
	}

	row.append(bar);

	const legend = createShareLegend(parts);

	if (legend) {
		row.append(legend);
	}

	return row;
}

/**
 * Полоски долей под названием. Сверху — тематики, поделившие вопросы между собой,
 * за ними жанры внутри тематики, потом годы и происхождение названного,
 * а снизу — из чего пак сделан: текст, картинки, музыка, видео и html.
 *
 * Порядок именно такой: верхние полоски отвечают на вопрос «про что этот пак»
 * и читаются как одна мысль от общего к частному — тематика, жанр внутри неё,
 * а следом два уточнения к тому же самому: каких лет это всё и чьё оно.
 * Состав же — вопрос совсем другой, про форму, а не про содержание, и стоять
 * между ними ему нечего.
 *
 * Полоска состава раньше показывала одну только музыку и оттого почти всегда была
 * недозаполненной: непонятно, то ли остальное — тишина, то ли просто ничего
 * не посчитано. Теперь в ней все виды содержимого, и она всегда полна на сотню.
 */
function createShares(pack) {
	const shares = pack.topicShares ?? {};
	const content = pack.contentStat ?? {};

	// Кусок «прочего» называется и красится по тому, чем это «прочее» оказалось:
	// у футбольного пака он зелёный и подписан «Футбол» (см. otherPart)
	const topics = createShareRow(
		SHARE_ORDER.map(key => (key === 'other'
			? otherPart(pack)
			: { key, name: topicInfo(key).name, value: shares[key] ?? 0 })),
		'shares__bar--topics',
		'вопросов пака',
		'О чём вопросы пака',
	);

	// Подписи над этой полоской нет нарочно: вопрос «Из чего состоит пак?» стоит
	// теперь над полоской жанров — там, где написано «рок, поп» и «шутеры, RPG»,
	// то есть про то, из чего пак и правда состоит. Здесь же речь про вид файлов
	// (текст, картинки, звук), и он читается как продолжение верхних полосок
	const contents = createShareRow(
		CONTENT_ORDER.map(key => ({ key, name: CONTENT_NAMES[key], value: content[key] ?? 0 })),
		'shares__bar--content',
		'содержимого пака',
		'Из чего сделаны вопросы',
	);

	const genres = createGenres(pack);
	const decades = createDecades(pack);
	const origins = createOrigins(pack);

	if (!topics && !contents && !genres && !decades && !origins) {
		return null;
	}

	const box = element('div', 'shares');

	for (const row of [topics, genres, decades, origins, contents]) {
		if (row) {
			box.append(row);
		}
	}

	return box;
}

/**
 * Вторая полоска: жанры внутри тематики пака. Есть она только у паков, которые
 * чем-то одним и являются, — у солянки жанр называть не от чего.
 *
 * Тип пака отвечает на вопрос «откуда вопросы», и у музпака ответ известен
 * заранее: музыка. А вот русский там рэп или опенинги нулевых, не было видно
 * ниоткуда, хотя играются такие паки совсем по-разному. Своей подписи над
 * полоской у неё нет: она стоит сразу под тематикой, продолжает её мысль
 * и называет то же самое подробнее — а сами жанры написаны словами под ней.
 * Вопрос («Какой жанр музыки?») остался подсказкой при наведении.
 *
 * Показывается только то, чего в паке набралось заметно (см. genreShare
 * в src/settings.js), а весь остальной пак сводится в один серый кусок:
 * полоска, полная на треть, читалась бы как «остальное не посчитано».
 */
function createGenres(pack) {
	const topic = pack.genreTopic;
	const genres = pack.genres ?? [];
	const list = facets.genreNames?.[topic];

	if (!topic || !list || genres.length === 0) {
		return null;
	}

	// Цвет куска — по месту в полоске, а не по ключу жанра: ключи у каждой
	// тематики свои, и один и тот же «comedy» встречается в трёх списках
	const parts = genres.map((genre, index) => ({
		key: `genre-${index + 1}`,
		name: list.list[genre.key] ?? genre.key,
		value: genre.share,
	}));

	const named = parts.reduce((sum, part) => sum + part.value, 0);

	// Остальной пак. Это не «жанра нет», а «каждого понемногу»: в подписи
	// он так и называется, чтобы не читаться как пробел в разметке
	if (named < 1) {
		parts.push({ key: 'genre-rest', name: 'Остальное вперемешку', value: 1 - named });
	}

	// Вопрос «Из чего состоит пак?» стоит именно здесь: жанры и есть ответ на него —
	// «рок, поп», «шутеры, RPG». Раньше эта подпись висела над нижней полоской,
	// но там перечислены текст, картинки и звук, то есть вид файлов, а не состав
	// пака. Какой это жанр и чего именно, по-прежнему говорит подсказка полоски
	// («Какой жанр музыки?») — над ней хватает одного вопроса
	return createShareRow(parts, 'shares__bar--genres', 'вопросов пака', list.question, 'Из чего состоит пак?');
}

/**
 * Годится ли паку полоска, которую спрашивают не у всех. Список типов приходит
 * с сервера (см. DECADE_TOPICS и ORIGIN_TOPICS в src/settings.js): десятилетия
 * у солянки и «наше — зарубежное» у аниме не значат ничего.
 *
 * Музыкальный пак проходит и мимо списка: аниме-пак, собранный из опенингов,
 * называется аниме-паком, но отгадывают в нём музыку, и обе полоски ему
 * полагаются как музпаку (см. isMusical).
 */
function topicAllows(pack, topics) {
	return (topics ?? []).includes(pack.primaryTopic) || isMusical(pack);
}

/**
 * Третья полоска: каких лет то, из чего собран пак.
 *
 * Ярлык про это молчит начисто. «Музпак» — это и сборник восьмидесятых,
 * и вчерашние тиктоки; «игропак» — и Dendy, и то, что вышло в прошлом месяце.
 * Играются они разными компаниями, и до сих пор угадать это можно было разве
 * что по возрасту аудитории — то есть задом наперёд.
 *
 * Показывается не всем и не всегда. Не всем — потому что у вопроса про столицы
 * или про химию года нет и быть не может (см. topicAllows). Не всегда — потому
 * что даже у музпака года известны не у каждой темы, и полоска, посчитанная
 * по одной десятой пака, звучала бы куда увереннее, чем есть на самом деле:
 * ниже decadeCoverage её просто нет (покрытие считает src/topics.js).
 */
function createDecades(pack) {
	const decades = pack.decades ?? [];

	if (decades.length === 0 || !topicAllows(pack, facets.decadeTopics)) {
		return null;
	}

	if ((pack.decadeCoverage ?? 0) < (facets.decadeCoverage ?? 1)) {
		return null;
	}

	// Цвет — по месту в полоске, как и у жанров, но порядок здесь не «от
	// большего к меньшему», а по времени: полоска годов, где восьмидесятые
	// стоят правее двадцатых, читается как ошибка, сколько её ни подписывай
	const parts = decades.map((decade, index) => ({
		key: `decade-${index + 1}`,
		name: decadeName(decade.key),
		value: decade.share,
	}));

	return createShareRow(parts, 'shares__bar--decades', 'названного в паке',
		'Каких лет то, что в паке', 'Когда это вышло?');
}

/** «1990-е», а самое давнее — одним куском: «до 1950-х» (см. decadeName в settings.js). */
function decadeName(decade) {
	const min = facets.decadeMin ?? 1950;
	return decade <= min ? `до ${min}-х` : `${decade}-е`;
}

/**
 * Четвёртая полоска: наше или зарубежное.
 *
 * Вопрос стоит у музыки и кино, и там он главный после жанра. «Музпак»
 * одинаково называется и сборник русского рэпа, и сборник западной эстрады,
 * а собираются под них разные компании, и жанр на это не отвечает: рок бывает
 * и наш, и не наш. У аниме-пака вопрос бессмысленный, и полоски там нет.
 *
 * Порог покрытия тот же и по той же причине, что у десятилетий: у вопроса
 * про мем происхождения нет, и считать по нему весь пак нельзя.
 */
function createOrigins(pack) {
	const origins = pack.origins ?? [];

	if (origins.length === 0 || !topicAllows(pack, facets.originTopics)) {
		return null;
	}

	if ((pack.originCoverage ?? 0) < (facets.originCoverage ?? 1)) {
		return null;
	}

	const names = facets.originNames ?? {};
	const parts = origins.map(part => ({
		key: `origin-${part.key}`,
		name: names[part.key] ?? part.key,
		value: part.share,
	}));

	return createShareRow(parts, 'shares__bar--origins', 'названного в паке',
		'Наше это или зарубежное', 'Наше или зарубежное?');
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

/**
 * Кому этот пак: возраст аудитории и её пол — две подписи в общей строке.
 *
 * Оба числа придуманы нейросетью по содержимому пака, и это надо читать именно
 * так. Настоящей статистики игроков не существует: SIGame считает запуски, а не
 * тех, кто запускал, — и никакого «70% мужчин» ни в каких данных нет. Модель
 * судит по годам вышедших игр и фильмов, по интернет-культуре, по тому, школьная
 * это программа или взрослая эрудиция. Поэтому в подсказке у обеих подписей
 * прямо сказано, откуда число: без этого его примут за измеренное.
 *
 * Женщин отдельным числом не храним: их доля — остаток до ста, и хранить её
 * значило бы завести вторую правду о том же самом.
 */
function createAudience(pack) {
	const audience = pack.audience;

	if (!audience) {
		return [];
	}

	const age = iconText('hourglass', `${audience.from}–${audience.to} лет`);
	age.title = `Кому этот пак примерно по возрасту: ${audience.from}–${audience.to} лет. `
		+ 'Оценка нейросети по темам и ответам пака, а не статистика игроков';

	const gender = iconText('gender', `${audience.male}% / ${100 - audience.male}%`);
	gender.title = `Мужчины ${audience.male}%, женщины ${100 - audience.male}%. `
		+ 'Оценка нейросети по темам и ответам пака, а не статистика игроков';

	return [age, gender];
}

/**
 * Ярлыки под названием: сложность, проценты за ней и тип пака.
 */
function createBadges(pack) {
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

	/**
	 * Ярлык тематики: по клику показывает все такие же паки.
	 *
	 * `text` перебивает обычную подпись «Кинопак 100%» — им называется вселенная
	 * пака про одно («Кинопак (Гарри Поттер)») и виды прочего у солянки.
	 */
	const createTopicBadge = (key, share, title, text = null) => {
		const info = topicInfo(key);
		const percent = share !== null && share !== undefined && key !== 'mixed' ? ` ${Math.round(share * 100)}%` : '';
		const badge = element('span', `badge badge--topic topic--${key}`);
		badge.append(topicIcon(key), element('span', null, text ?? `${info.packName}${percent}`));
		badge.title = title;

		// Клик по ярлыку — это «покажи только такие»: прежний набор типов заменяется,
		// а не дополняется. Набирать несколько удобнее галочками слева
		badge.addEventListener('click', () => pickFilter('topic', key));

		return badge;
	};

	// Дополнительный тип: пак целиком про одно — про Вархаммер, про футбол,
	// про Вторую мировую, про Гарри Поттера. Берётся самый частый предмет пака,
	// если он занял больше половины вопросов; предметы приходят отсортированными
	// от частых к редким, поэтому это первый в списке. Годится и произведение,
	// и область: паку про футбол мишень нужна ровно так же, как паку про «Наруто»,
	// хотя повтором область не считается (см. computeAreas в src/topics.js).
	const mostCommon = (pack.franchises ?? [])[0];
	const universe = universeOf(pack);
	// У пака про одну вселенную мишень не нужна: вселенная уже названа в самом
	// ярлыке тематики, и два одинаковых ярлыка подряд — это не подробность
	const subject = !universe && mostCommon && mostCommon.share >= facets.subjectPackShare ? mostCommon : null;

	// Чем оказалось «прочее»: у солянки и у пака с ярлыком «Прочее» это
	// единственное, что вообще говорит, о чём он. «Солянка (стримеры, история)»
	const kinds = pack.primaryTopic === 'mixed' || pack.primaryTopic === 'other' ? otherKindsLine(pack) : '';

	// Солянка вместе с таким типом не показывается: «Солянка · Футбол» —
	// это спор с самим собой. Солянкой пак про футбол числится только потому,
	// что спорт живёт в «прочем» и ни одна из пяти тематик порога не берёт;
	// сказать про такой пак «он про футбол» и точнее, и полезнее.
	if (pack.primaryTopic && !(subject && pack.primaryTopic === 'mixed')) {
		const info = topicInfo(pack.primaryTopic);

		badges.append(createTopicBadge(
			pack.primaryTopic,
			pack.primaryShare,
			universe
				? `Пак целиком про одно: «${universe.name}» — ${universe.themes} `
					+ `${plural(universe.themes, 'тема', 'темы', 'тем')} и ${Math.round(universe.share * 100)}% вопросов пака`
				: pack.primaryTopic === 'mixed'
					? `Ни одна тематика не набрала ${Math.round(facets.topicThreshold * 100)}% вопросов`
						+ (kinds ? `. Больше всего вопросов про это: ${kinds}` : '')
					: `${topicInfo(pack.primaryTopic).name}: ${Math.round(pack.primaryShare * 100)}% вопросов пака`
						+ (kinds ? ` (${kinds})` : ''),
			// Процент у пака про одну вселенную не пишется: он и так стоит рядом
			// на полоске долей, а место в ярлыке нужнее самой вселенной
			universe ? `${info.packName} (${universe.name})` : kinds ? `${info.packName} (${kinds})` : null,
		));
	}

	if (subject) {
		const badge = element('button', 'badge badge--subject');
		badge.type = 'button';
		badge.append(icon('target'), element('span', null, `${subject.name} ${Math.round(subject.share * 100)}%`));
		badge.title = `Пак целиком про одно: «${subject.name}» — ${subject.themes} `
			+ `${plural(subject.themes, 'тема', 'темы', 'тем')} и ${Math.round(subject.share * 100)}% вопросов пака. `
			+ 'Нажмите, чтобы показать все паки этого типа';

		badge.addEventListener('click', () => pickFilter('subject', subject.name));

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

	return badges;
}

/**
 * Кнопка «Отметить сыгранным». Стоит отдельной строкой НАД «Играть» и «Скачать»
 * нарочно: играть и скачивать идут туда, где пака ещё не видели, а отмечают его
 * те, кто уже вернулся со стола, — и с этой отметки у них начинается всё
 * остальное, потому что оценку ставят только сыгранному.
 *
 * @param {Function} onDone что перерисовать после переключения
 */
function createPlayedButton(pack, onDone) {
	const played = element('button', `button button--mark${isPlayed(pack) ? ' button--active' : ''}`);
	played.type = 'button';

	// Кнопка нажимается всегда. Без входа отметка ложится не на сервер, а в сам
	// браузер, и подсказка честно говорит, чем одно отличается от другого: обещать
	// «сохранено навсегда» там, где список знает только эта машина, нельзя.
	if (!serverMarks()) {
		played.title = 'Отметка сохранится в этом браузере. Войдите через Discord — '
			+ 'и все отметки переедут в учётную запись, где их видно с любого устройства';
	}

	const render = () => {
		played.textContent = '';

		if (isPlayed(pack)) {
			played.append(icon('check'), element('span', null, 'Сыграно'));
		} else {
			played.append(element('span', null, 'Отметить сыгранным'));
		}

		played.classList.toggle('button--active', isPlayed(pack));
	};

	render();

	played.addEventListener('click', async () => {
		played.disabled = true;

		try {
			const next = !isPlayed(pack);

			if (serverMarks()) {
				const response = await fetch('/api/played', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ id: pack.id, played: next }),
				});

				const result = await response.json();
				pack.played = result.played;
			} else if (next) {
				localPlayed.add(pack.packKey);
				saveLocalPlayed();
			} else {
				localPlayed.delete(pack.packKey);
				saveLocalPlayed();
			}

			render();
			onDone();
			onPlayedChange(pack);
		} finally {
			played.disabled = false;
		}
	});

	return played;
}

/**
 * Кнопка «Запланировать». Стоит в одной строке с «Отметить сыгранным», справа
 * от неё: обе отвечают на вопрос «а что у меня с этим паком», только одна про
 * прошлое, а другая про будущее. Отложенное собирается в профиле отдельным
 * списком — оттуда за него и садятся.
 *
 * Уже сыгранный пак запланировать по-прежнему можно: во что-то садятся и по
 * второму разу, и запрещать это значило бы решать за человека.
 *
 * @param {Function} onDone что перерисовать после переключения
 */
function createPlannedButton(pack, onDone) {
	const button = element('button', `button button--mark button--plan${isPlanned(pack) ? ' button--active' : ''}`);
	button.type = 'button';

	const render = () => {
		button.textContent = '';
		button.append(icon('bookmark'), element('span', null, isPlanned(pack) ? 'В планах' : 'Запланировать'));
		button.classList.toggle('button--active', isPlanned(pack));

		button.title = isPlanned(pack)
			? 'Пак отложен на будущее и лежит в профиле, в «Запланированном». Нажмите, чтобы убрать оттуда'
			: 'Отложить пак на будущий вечер: он соберётся списком в профиле'
				+ (serverMarks() ? '' : '. Отметка сохранится в этом браузере — войдите через Discord, '
					+ 'и она переедет в учётную запись');
	};

	render();

	button.addEventListener('click', async () => {
		button.disabled = true;

		try {
			const next = !isPlanned(pack);

			if (serverMarks()) {
				const response = await fetch('/api/planned', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ id: pack.id, planned: next }),
				});

				const result = await response.json();

				if (result.error) {
					alert(result.error);
					return;
				}

				pack.planned = result.planned;
			} else if (next) {
				localPlanned.add(pack.packKey);
				saveLocalPlanned();
			} else {
				localPlanned.delete(pack.packKey);
				saveLocalPlanned();
			}

			render();
			onDone();
			onPlannedChange(pack);
		} finally {
			button.disabled = false;
		}
	});

	return button;
}

/**
 * «Поделиться»: кладёт ссылку на страницу пака в буфер обмена.
 *
 * Ссылка эта появилась только теперь — раньше у пака не было своего адреса вовсе,
 * и «смотри какой пак» приходилось пересказывать названием. Копируется она сразу,
 * без открытия чего бы то ни было: делятся паком в чужом окне — в Discord или ВК, —
 * и всё, что для этого нужно, это адрес в буфере.
 *
 * Молча копировать нельзя: нажатие, после которого на странице не изменилось
 * ничего, читается как несработавшее. Отсюда всплывающая подпись внизу экрана.
 */
function createShareButton(pack) {
	const button = element('button', 'button button--ghost button--share');
	button.type = 'button';
	button.append(icon('share'));
	button.title = 'Скопировать ссылку на пак';
	button.setAttribute('aria-label', button.title);

	button.addEventListener('click', async event => {
		event.stopPropagation();
		const link = new URL(packHref(pack), window.location.origin).href;

		if (await copyText(link)) {
			showToast('Ссылка на пак скопирована');
		} else {
			// Копировать не дали — ни буфера, ни разрешения. Тогда хотя бы покажем
			// сам адрес: выделить его руками всё ещё можно, а молчать нельзя
			showToast(`Не вышло скопировать. Ссылка: ${link}`);
		}
	});

	return button;
}

/**
 * «Скрин»: вся карточка целиком — картинкой в буфер обмена.
 *
 * Зачем. Паком делятся в чужом окне, и ссылка там разворачивается в лучшем случае
 * названием: ни сложности, ни долей, ни оценки, ни состава раундов в ней не видно,
 * а решают именно они — «смотри, тут 70% аниме и коты в мешке». Пересказывать это
 * словами дольше, чем показать. Снимок же экрана руками захватывает соседние
 * карточки и обрезается по нижнему краю окна, а «подробности» на нём свёрнуты.
 *
 * Как это сделано. Никакой сторонней библиотеки для этого нет: карточка рисуется
 * тем же браузером, что и на экране. Её копия кладётся внутрь картинки-SVG
 * (foreignObject), туда же целиком уезжает стиль сайта — и картинка рисуется
 * на холсте, откуда уходит в буфер обмена уже как PNG.
 *
 * Из этого следуют две вещи, которые здесь и сделаны руками:
 *
 *   картинки внутри SVG наружу не ходят вовсе — обложка обязана быть уже внутри
 *     файла, поэтому она заранее переводится в data:-строку (см. inlineImages);
 *   мерка вёрстки (rem) висит на html, а в картинке никакого html нет — её
 *     приходится назначать корню SVG, иначе снимок выходит другого размера,
 *     чем то же самое на экране.
 */
const SHOT_SCALE = 2;

/** Поля вокруг карточки на снимке, точки. Впритык обрезанная карточка выглядит обрывком. */
const SHOT_PADDING = 16;

/** Стиль сайта, прочитанный один раз на все снимки: файл под сотню килобайт. */
let siteStyle = null;

function siteStyleText() {
	if (!siteStyle) {
		const link = document.querySelector('link[rel="stylesheet"]');

		siteStyle = link
			? fetch(link.href).then(response => (response.ok ? response.text() : '')).catch(() => '')
			: Promise.resolve('');
	}

	return siteStyle;
}

/**
 * Обложки — внутрь самой картинки. Изнутри SVG браузер не идёт ни за чем: ни
 * за файлом с того же сайта, ни тем более за чужим, — и обложка, оставленная
 * ссылкой, на снимке просто не появится. Что не отдалось, убирается совсем:
 * пустая рамка на месте картинки хуже её отсутствия.
 */
async function inlineImages(root) {
	await Promise.all([...root.querySelectorAll('img')].map(async image => {
		const src = image.getAttribute('src') ?? '';

		if (!src || src.startsWith('data:')) {
			return;
		}

		try {
			const response = await fetch(src);

			if (!response.ok) {
				throw new Error(String(response.status));
			}

			const blob = await response.blob();

			image.setAttribute('src', await new Promise((resolve, reject) => {
				const reader = new FileReader();
				reader.addEventListener('load', () => resolve(reader.result));
				reader.addEventListener('error', () => reject(reader.error));
				reader.readAsDataURL(blob);
			}));
		} catch {
			image.remove();
		}
	}));
}

/** Карточка — картинкой PNG. Возвращает blob или null, если холст ничего не отдал. */
async function cardToImage(card) {
	const clone = card.cloneNode(true);

	// «Подробности» на снимке раскрыты: за составом раундов за ним и лезут.
	// Свёрнутое описание тоже разворачивается — обрезка по четырём строкам нужна
	// выдаче, чтобы карточки не разъезжались по высоте, а у снимка соседей нет
	clone.classList.remove('card--clickable');

	for (const details of clone.querySelectorAll('details')) {
		details.open = true;
	}

	for (const box of clone.querySelectorAll('.description')) {
		box.classList.add('description--open');
	}

	// Кнопки со снимка убраны все разом: «Играть», «Скачать», «Отметить сыгранным»
	// на картинке не нажимаются, и место занимают ровно зря. Остаётся то, ради чего
	// карточкой и делятся, — название, оценка, доли, темы, описание, состав
	for (const extra of clone.querySelectorAll('.card__actions, .description__more, .card__name-copy, .author-ban, .hide')) {
		extra.remove();
	}

	// Копия меряется на настоящей странице, а не на глаз: высота карточки известна
	// только после того, как браузер разложил её текст по строкам. Стоит она при
	// этом за краем экрана — увидеть её нельзя, а размеры у неё настоящие
	const width = Math.ceil(card.getBoundingClientRect().width);
	const stage = element('div');
	stage.style.cssText = `position:fixed;left:-20000px;top:0;width:${width}px;pointer-events:none;`;
	stage.append(clone);
	document.body.append(stage);

	let markup;
	let height;

	try {
		await inlineImages(clone);
		height = Math.ceil(clone.getBoundingClientRect().height);
		// XMLSerializer, а не innerHTML: внутри SVG разметка обязана быть правильным
		// XML — с закрытыми <img> и своим пространством имён у значков
		markup = new XMLSerializer().serializeToString(clone);
	} finally {
		stage.remove();
	}

	const css = await siteStyleText();
	const page = getComputedStyle(document.body);
	// Мерка вёрстки: на странице она висит на html, а корень картинки — сам SVG
	const rootSize = getComputedStyle(document.documentElement).fontSize;

	const full = { width: width + SHOT_PADDING * 2, height: height + SHOT_PADDING * 2 };

	// Поля и шрифт страницы — правилом в стиле, а не атрибутом style у самой
	// коробки: имя шрифта браузер отдаёт уже в кавычках («"Segoe UI", system-ui»),
	// и в атрибуте XML эти кавычки закрывают его на середине — картинка после
	// такого не разбирается вовсе.
	const pageStyle = `.shot-page{width:${full.width}px;padding:${SHOT_PADDING}px;box-sizing:border-box;`
		+ `background:${page.backgroundColor};color:${page.color};font-family:${page.fontFamily};`
		+ `font-size:${page.fontSize};line-height:${page.lineHeight};}`;

	// Стиль уезжает внутрь XML, и два знака в нём значат для разбора больше,
	// чем для CSS
	const escaped = `:root{font-size:${rootSize};}${pageStyle}${css}`
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;');

	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${full.width}" height="${full.height}">`
		+ '<foreignObject x="0" y="0" width="100%" height="100%">'
		+ '<div xmlns="http://www.w3.org/1999/xhtml" class="shot-page">'
		+ `<style>${escaped}</style>${markup}</div></foreignObject></svg>`;

	const image = new Image();
	image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
	await image.decode();

	// Вдвое подробнее экрана: снимок смотрят на чужом мониторе и в чужом окне,
	// где его растягивают, — а мылом текст карточки не читается вовсе
	const canvas = element('canvas');
	canvas.width = full.width * SHOT_SCALE;
	canvas.height = full.height * SHOT_SCALE;

	const context = canvas.getContext('2d');
	context.fillStyle = page.backgroundColor || '#0e1015';
	context.fillRect(0, 0, canvas.width, canvas.height);
	context.setTransform(SHOT_SCALE, 0, 0, SHOT_SCALE, 0, 0);
	context.drawImage(image, 0, 0, full.width, full.height);

	return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}

/**
 * Картинка — в буфер обмена. Работает это только на защищённом соединении
 * и не во всяком браузере; домашний сайт открывают по http с соседней машины,
 * и там остаётся второй способ — сохранить файлом (см. кнопку).
 */
async function copyImage(blob) {
	try {
		if (navigator.clipboard && window.ClipboardItem && window.isSecureContext) {
			await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
			return true;
		}
	} catch {
		// Не дали — значит, файлом
	}

	return false;
}

/** Запасной путь: тот же снимок, но файлом на диск. */
function saveImage(blob, pack) {
	const url = URL.createObjectURL(blob);
	const link = element('a');
	link.href = url;
	link.download = `${pack.slug || `pack-${pack.id}`}.png`;
	document.body.append(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Кнопка «Скрин». Стоит в общей строке действий рядом с «Поделиться»: обе про то,
 * как унести пак отсюда наружу, — одна ссылкой, другая картинкой.
 */
function createShotButton(pack, card) {
	const button = element('button', 'button button--ghost button--shot');
	button.type = 'button';
	button.append(icon('camera'), element('span', null, 'Скрин'));
	button.title = 'Снять карточку целиком, вместе с подробностями, и положить картинкой в буфер обмена';

	button.addEventListener('click', async event => {
		event.stopPropagation();

		button.disabled = true;
		showToast('Снимаю карточку…');

		try {
			const blob = await cardToImage(card);

			if (!blob) {
				throw new Error('картинка не нарисовалась');
			}

			if (await copyImage(blob)) {
				showToast('Карточка скопирована картинкой');
			} else {
				// Молчать нельзя: человек нажал «в буфер», а получил файл — и знать
				// об этом должен он, а не папка загрузок
				saveImage(blob, pack);
				showToast('Буфер обмена недоступен — снимок сохранён файлом');
			}
		} catch (error) {
			showToast(`Не вышло снять карточку: ${error.message}`);
		} finally {
			button.disabled = false;
		}
	});

	return button;
}

/**
 * «Скопировать название» — маленький знак справа от названия пака.
 *
 * Уходит в буфер ровно то, что написано, — без ссылки, без автора, без кавычек:
 * этой строкой пак ищут в самой SIGame, в обсуждении и в чужом чате, и лишнее
 * в ней приходится стирать руками.
 *
 * Нажатие не открывает страницу пака, хотя стоит кнопка внутри карточки, которая
 * вся на это нажатие и настроена: у кнопок это учтено разом (см. OWN_TARGETS),
 * а остановка события нужна ещё и ссылке названия, внутри которой знак не стоит.
 */
function createCopyNameButton(name) {
	const button = element('button', 'card__name-copy');
	button.type = 'button';
	button.append(icon('copy'));
	button.title = `Скопировать название: «${name}»`;
	button.setAttribute('aria-label', button.title);

	button.addEventListener('click', async event => {
		event.stopPropagation();
		event.preventDefault();

		if (await copyText(name)) {
			showToast('Название пака скопировано');
		} else {
			showToast('Не вышло скопировать название');
		}
	});

	return button;
}

/**
 * «Обновить пак» — точечное обновление одного пака прямо с его страницы.
 *
 * Зачем оно тут. Пак изредка разбирается криво: модель не узнала произведение,
 * автор перезалил файл, статистика была снята, когда в пак ещё никто не играл.
 * Чинилось это раньше только полным проходом по базе — то есть тем, что за ночь
 * доходит до этого пака в лучшем случае. Теперь тот же самый индексатор
 * запускается ровно по одному номеру: разбор, статистика, проценты, описание,
 * логотип — всё заново и только у него (см. --packs в src/indexer.js).
 *
 * Кнопки нет на общем сайте и нет в выдаче: на хостинге обновлять нечем,
 * а в библиотеке карточек по двадцать штук, и такое действие рядом со «Скачать»
 * нажималось бы случайно. Место ей — на странице пака, куда приходят разбираться
 * именно с ним.
 */
function createUpdateButton(pack) {
	const button = element('button', 'button button--ghost', 'Обновить');
	button.type = 'button';
	button.title = 'Собрать всё про этот пак заново: разбор, статистику, проценты категорий, описание';

	button.addEventListener('click', async event => {
		event.stopPropagation();

		if (!confirm(`Обновить пак «${pack.name ?? pack.fileName}» целиком? `
			+ 'Разбор, статистика, проценты категорий и описание будут собраны заново. '
			+ 'Ход работы будет виден на странице обновления.')) {
			return;
		}

		button.disabled = true;

		let data;

		try {
			const response = await fetch('/api/update/start', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					// Статистика берётся полным шагом, а не «только у новых»: тот
					// спрашивает лишь про паки без статистики вовсе, а здесь нужно
					// переспросить как раз про тот, у которого она уже есть.
					// По одному паку это один запрос, а не пять тысяч.
					steps: ['parse', 'stats', 'topics', 'summary', 'logos'],
					options: { packs: [pack.id], force: true },
				}),
			});

			data = await response.json();
		} catch (error) {
			data = { error: `Сайт не ответил на запуск: ${error.message}` };
		}

		if (data.error) {
			button.disabled = false;
			alert(data.error);
			return;
		}

		window.location.href = `/update?packs=${pack.id}`;
	});

	return button;
}

/**
 * Кладёт строку в буфер обмена. Нынешний способ работает только на защищённом
 * соединении, а домашний сайт открывают по http с соседней машины — там остаётся
 * старый, через невидимое поле ввода.
 */
async function copyText(text) {
	try {
		if (navigator.clipboard && window.isSecureContext) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch {
		// Не вышло — пробуем по-старому
	}

	try {
		const field = element('textarea');
		field.value = text;
		field.setAttribute('readonly', '');
		field.style.position = 'fixed';
		field.style.opacity = '0';
		document.body.append(field);
		field.select();

		const done = document.execCommand('copy');
		field.remove();
		return done;
	} catch {
		return false;
	}
}

/** Сколько всплывающая подпись висит на экране, миллисекунды. */
const TOAST_TIME = 2600;

let toastTimer = null;

/**
 * Всплывающая подпись внизу экрана: «скопировано». Одна на всю страницу — два
 * сообщения подряд заменяют друг друга, а не выстраиваются в столбик.
 */
function showToast(text) {
	let toast = document.querySelector('.toast');

	if (!toast) {
		toast = element('div', 'toast');
		toast.setAttribute('role', 'status');
		document.body.append(toast);
	}

	toast.textContent = text;
	// Перезапуск появления: без снятия класса вторая подпись подряд возникала бы
	// без него — она уже показана
	toast.classList.remove('toast--shown');
	void toast.offsetWidth;
	toast.classList.add('toast--shown');

	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => toast.classList.remove('toast--shown'), TOAST_TIME);
}

/**
 * Карточка пака.
 *
 * @param {object} pack
 * @param {object} options
 *   standalone — карточка на собственной странице пака: она там одна, название
 *     становится заголовком страницы, описание не сворачивается, а состав раундов
 *     раскрыт сразу. В выдаче всё наоборот: название ведёт на эту самую страницу,
 *     а лишнее спрятано, чтобы карточки не разъезжались по высоте.
 */
/**
 * Что внутри карточки нажимается само по себе и открывать страницу пака
 * при этом не должно: кнопки, ссылки, темы, звёзды оценки. Всё остальное —
 * обложка, числа, полоски, описание — мишень для перехода (см. makeCardClickable).
 */
const OWN_TARGETS = 'a, button, input, label, select, textarea, summary, .tag, .badge--topic, .rating, .card__ban';

/**
 * Нажатие на карточку целиком открывает страницу пака.
 *
 * Раньше туда вели только название и обложка — то есть узкая полоска в самом
 * верху, — а вся остальная карточка была величиной с пол-экрана и не делала
 * ничего. Целиться в заголовок приходилось глазами, и на телефоне особенно:
 * там карточка занимает всю ширину, а мишень в ней — две строки текста.
 *
 * Название и обложка остаются настоящими ссылками: у них свой адрес, их видит
 * поисковик, их открывают средней кнопкой и «в новой вкладке» из меню. Здешний
 * обработчик — добавка к ним, а не замена.
 *
 * Не срабатывает он в трёх случаях: нажали по тому, что и так нажимается
 * (кнопки, темы, звёзды); выделяли мышью текст описания — тогда отпускание
 * кнопки не переход, а конец выделения; держали Ctrl, Shift или среднюю
 * кнопку — тогда открываем в новой вкладке, как это делает сама ссылка.
 */
function makeCardClickable(card, pack) {
	card.classList.add('card--clickable');

	const open = event => {
		if (event.defaultPrevented || event.target.closest(OWN_TARGETS)) {
			return;
		}

		// Выделять текст на карточке никто не запрещал, и заканчивать выделение
		// переходом на другую страницу — худшее, что можно сделать в ответ
		if (String(window.getSelection?.() ?? '').length > 0) {
			return;
		}

		const href = packHref(pack);

		if (event.button === 1 || event.ctrlKey || event.metaKey || event.shiftKey) {
			window.open(href, '_blank', 'noopener');
		} else if (event.button === 0) {
			window.location.href = href;
		}
	};

	card.addEventListener('click', open);
	// Средняя кнопка приходит отдельным событием: обычный click на неё не срабатывает
	card.addEventListener('auxclick', open);
}

function createCard(pack, options = {}) {
	const standalone = options.standalone === true;
	const card = element('div', 'card'
		+ (standalone ? ' card--page' : '')
		+ (isPlayed(pack) ? ' card--played' : ''));

	// На своей странице пака переходить некуда: она и есть та страница
	if (!standalone) {
		makeCardClickable(card, pack);
	}

	// Самая верхняя строка карточки: слева дата, посередине число вопросов,
	// справа — сколько раз играли. Все три отвечают на один и тот же вопрос —
	// «стоит ли вообще смотреть дальше»: свежий пак или лежит с позапрошлого года,
	// на один вечер он или на три, играют его или он никому не нужен.
	//
	// Число вопросов раньше стояло внизу, в строке мелких цифр под описанием, —
	// а решает оно не меньше сложности: пак на полсотни вопросов и пак на четыре
	// сотни это разные вечера, и знать это надо до того, как читать про пак дальше.
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

	if (pack.questionCount) {
		// Словом, а не одним значком: «178 вопросов» читается само, а знак вопроса
		// рядом с числом в верхней строке спорил бы с плашкой игр — там тоже число
		// со словом, и два разных числа со значками рядом сливаются в одно.
		const questions = element('div', 'card__questions');
		questions.append(
			element('span', 'card__questions-value', formatNumber(pack.questionCount)),
			element('span', 'card__questions-unit', plural(pack.questionCount, 'вопрос', 'вопроса', 'вопросов')),
		);
		questions.title = `Вопросов в паке: ${formatNumber(pack.questionCount)}`
			+ (pack.roundCount ? `, раундов: ${pack.roundCount}` : '');
		top.append(questions);
	}

	top.append(createGames(pack));
	card.append(top);

	const head = element('div', 'card__head');

	// Обложка ведёт туда же, куда и название: на страницу пака. В выдаче по ней
	// целятся не реже, чем по заголовку, — она крупнее всего остального.
	if (standalone) {
		head.append(createLogo(pack));
	} else {
		const cover = element('a', 'card__cover');
		cover.href = packHref(pack);
		cover.tabIndex = -1;
		cover.setAttribute('aria-hidden', 'true');
		cover.append(createLogo(pack));
		head.append(cover);
	}

	const titleBox = element('div', 'card__title');
	const name = pack.name ?? pack.fileName ?? 'Без названия';

	// На своей странице пак — это и есть страница, поэтому название там заголовок
	// первого уровня и никуда не ведёт. В выдаче оно ссылка: у пака есть
	// собственный адрес, и поисковику попасть на него больше неоткуда — дальше
	// первой страницы выдачи он не листает, там кнопки, а не ссылки.
	//
	// Справа от названия стоит кнопка «скопировать»: пак ищут не только здесь.
	// Название нужно, чтобы найти его же в самой SIGame, скинуть строкой в чат
	// или поискать в обсуждении, — и до сих пор его выделяли мышью по буквам,
	// а на карточке в выдаче выделение ещё и спорит с переходом на страницу пака.
	// Копируется голое название, без ссылки и без автора: ссылкой делится соседняя
	// кнопка внизу карточки, а здесь просят ровно ту строку, что написана.
	const nameRow = element('div', 'card__name-row');

	if (standalone) {
		nameRow.append(element('h1', 'card__name', name));
	} else {
		const link = element('a', 'card__name-link');
		link.href = packHref(pack);
		link.title = `Открыть страницу пака «${name}»`;
		link.append(element('h3', 'card__name', name));
		nameRow.append(link);
	}

	nameRow.append(createCopyNameButton(name));
	titleBox.append(nameRow);

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
			link.addEventListener('click', () => pickFilter('author', author));
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

	titleBox.append(createBadges(pack));
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
		const canRate = Boolean(user) && isPlayed(pack);

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
		// в карточке главным: встают по центру отдельной строкой и вырастают втрое.
		// Половина звезды здесь — целый балл, а мелкими она шириной в три пикселя,
		// и «7 из 10» ставилось наугад; в крупные попадают с первого раза.
		//
		// Крупными они становятся от самой отметки, а не от возможности оценить:
		// вошёл человек или нет, сыгранный пак на карточке главный, и звёзды у него
		// — то место, куда он смотрит.
		if (isPlayed(pack)) {
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
			chip.addEventListener('click', () => pickFilter('tag', tag));
			tags.append(chip);
		}

		card.append(tags);
	}

	// Описание от автора идёт сразу за темами: темы говорят, о чём пак, описание —
	// что за ними стоит. Раньше оно лежало в «Подробнее», куда заглядывают в
	// последнюю очередь, — и половина карточек выглядела так, будто их не описывали
	const description = createDescription(pack, standalone);

	if (description) {
		card.append(description);
	}

	const meta = element('div', 'meta');
	const size = formatSize(pack.size);

	// Ни даты, ни числа вопросов здесь больше нет: оба вынесены в самую верхнюю
	// строку карточки, к числу игр

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

	// Кому этот пак. Стоит в подписи, а не плашкой наверху: вопрос «мне ли он»
	// решается уже после того, как человек посмотрел на тематики и оценку,
	// и лишним ярлыком в шапке был бы шумом.
	for (const item of createAudience(pack)) {
		meta.append(item);
	}

	// Числа игр здесь больше нет: оно вынесено плашкой в самый верх карточки

	card.append(meta);

	const details = element('details', 'details');
	details.append(element('summary', null, 'Подробнее'));

	// На своей странице пака прятать состав раундов не за чем: за ней и приходят,
	// чтобы посмотреть, что внутри, — а поисковику это единственный текст пака,
	// написанный не сайтом.
	details.open = standalone;

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

	// Отметка «сыграно» — своей строкой над всем остальным. Играть и скачивать
	// идут те, кто пак ещё не видел, а отмечают его вернувшиеся со стола, и дальше
	// у них всё держится на этой отметке: оценка ставится только сыгранному.
	const marks = element('div', 'card__actions card__actions--mark');

	// «Запланировать» — вторая половина той же строки: одна кнопка про прошлое
	// пака, вторая про будущее, и стоять им порознь не за чем
	let plan = createPlannedButton(pack, () => {});

	const played = createPlayedButton(pack, () => {
		const wasPlanned = isPlanned(pack);
		card.classList.toggle('card--played', isPlayed(pack));

		// Оценивать можно только сыгранное — значит, звёзды меняют своё состояние
		// вместе с этой кнопкой, а не после обновления страницы
		const stars = buildRating();
		rating.replaceWith(stars);
		rating = stars;

		// Сыграли — «собираемся сыграть» кончилось: так же, как это делает сервер
		// (см. setPlayed). Кнопка обязана сказать об этом сразу, а не после
		// обновления страницы, иначе выглядит, будто пак остался в планах.
		if (isPlayed(pack) && wasPlanned) {
			pack.planned = false;
			localPlanned.delete(pack.packKey);
			saveLocalPlanned();

			const next = createPlannedButton(pack, () => {});
			plan.replaceWith(next);
			plan = next;
			onPlannedChange(pack);
		}
	});

	marks.append(played, plan);
	card.append(marks);

	const actions = element('div', 'card__actions');

	actions.append(createPlayLink(pack, facets.playerUri));

	const download = element('a', 'button', 'Скачать');
	download.href = pack.url;
	download.target = '_blank';
	download.rel = 'noreferrer noopener';
	actions.append(download);

	// «Поделиться» — прямо перед чёрным списком: обе кнопки без подписи, обе
	// про сам пак, а не про игру им, и стоят они в конце строки одна за другой.
	actions.append(createShareButton(pack));

	// «Скрин» — рядом с «Поделиться»: обе уносят пак отсюда наружу, одна ссылкой,
	// другая картинкой. Картинка нужна там, где ссылка не разворачивается ни во что:
	// в чате она остаётся одним названием, а по карточке видно всё сразу
	actions.append(createShotButton(pack, card));

	// Точечное обновление — только на своей странице пака и только дома:
	// на хостинге индексатора нет вовсе (см. createUpdateButton)
	if (standalone && !facets.readOnly) {
		actions.append(createUpdateButton(pack));
	}

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

/**
 * Закрывать меню чёрного списка щелчком мимо него надо на каждой странице,
 * где есть карточки: иначе оно висит поверх всего, пока не нажмёшь ту же кнопку
 * ещё раз.
 */
document.addEventListener('click', () => {
	for (const menu of document.querySelectorAll('.hide__menu')) {
		menu.hidden = true;
	}
});
