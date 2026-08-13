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
			note.textContent = state.count > 0
				? `${state.count} из ${minRatings} оценок`
				: `нет оценок`;
		}

		if (state.mine !== null) {
			note.textContent += ` · ваша ${state.mine}`;
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

/** Ссылка «Играть» на официальный движок с уже подставленным паком. */
function createPlayLink(pack, playerUri) {
	const play = element('a', 'button button--primary', 'Играть');
	play.href = `${playerUri}?packageUri=${encodeURIComponent(pack.url)}&packageName=${encodeURIComponent(pack.name ?? '')}`;
	play.target = '_blank';
	play.rel = 'noreferrer noopener';
	return play;
}
