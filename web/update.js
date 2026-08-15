'use strict';

// Страница обновления базы: галочки превращаются во флаги индексатора,
// а его вывод приходит обратно потоком событий.

const $ = id => document.getElementById(id);

/** Шаги, отмеченные при первом открытии: обычный полный проход без служебных. */
const DEFAULT_STEPS = new Set(['vk', 'parse', 'stats', 'topics', 'summary']);

const selected = new Set();
let steps = [];
let running = false;
let logAtBottom = true;

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

function renderSteps() {
	const box = $('steps');
	box.textContent = '';

	for (const step of steps) {
		const label = element('label', 'step');
		const input = element('input');
		input.type = 'checkbox';
		input.checked = selected.has(step.key);
		input.disabled = running;

		input.addEventListener('change', () => {
			if (input.checked) {
				selected.add(step.key);
			} else {
				selected.delete(step.key);
			}
		});

		const body = element('div', 'step__body');
		body.append(element('span', 'step__name', step.name), element('span', 'step__hint', step.hint));

		label.append(input, body);
		box.append(label);
	}
}

/** Человеческая запись остатка времени: «2 ч 05 мин», «14 мин», «40 с». */
function formatSpan(ms) {
	if (!ms || !Number.isFinite(ms)) {
		return '';
	}

	const seconds = Math.round(ms / 1000);

	if (seconds < 90) {
		return `${seconds} с`;
	}

	const minutes = Math.round(seconds / 60);

	if (minutes < 90) {
		return `${minutes} мин`;
	}

	return `${Math.floor(minutes / 60)} ч ${String(minutes % 60).padStart(2, '0')} мин`;
}

/**
 * Полоски выполнения: по одной на шаг нынешнего запуска.
 *
 * Шаги идут разом, поэтому «идёт» не один, а несколько, и у каждого свой остаток
 * времени. Знак «+» у числа значит, что работа этому шагу ещё подносится: обход
 * ВК находит паки для разбора, разбор готовит их для статистики и модели, — общее
 * число до конца работы не окончательно.
 */
function renderProgress(state) {
	const box = $('progress');
	box.textContent = '';

	const active = new Set(state.active ?? []);

	for (const step of state.steps ?? []) {
		const item = state.progress?.[step.key] ?? {};
		const total = item.total ?? 0;
		const done = item.finished ? total : item.done ?? 0;
		const live = active.has(step.key);

		const row = element('div', `progress__row${live ? ' progress__row--active' : ''}`);
		row.append(element('span', 'progress__name', step.name));

		const bar = element('div', 'progress__bar');
		const fill = element('div', 'progress__fill');
		fill.style.width = total > 0 ? `${Math.round((done / total) * 100)}%` : (item.finished ? '100%' : '0%');
		bar.append(fill);
		row.append(bar);

		const counted = total > 0 ? `${done} из ${total}${item.growing ? '+' : ''}` : `${done || ''}`.trim() || 'работаю';
		const text = item.finished ? 'готово' : live ? counted : total > 0 ? counted : 'в очереди';

		const count = element('span', 'progress__count', text);

		if (!item.finished && live && item.eta) {
			count.append(element('span', 'progress__eta', `~${formatSpan(item.eta)}`));
		}

		row.append(count);
		box.append(row);
	}
}

function appendLog(lines) {
	const log = $('log');
	log.append(document.createTextNode(lines.join('\n') + '\n'));

	// Пролистываем сами, только если пользователь и так смотрит на конец
	if (logAtBottom) {
		log.scrollTop = log.scrollHeight;
	}
}

function formatTime(ms) {
	const seconds = Math.round(ms / 1000);
	const minutes = Math.floor(seconds / 60);
	return minutes > 0 ? `${minutes} мин ${seconds % 60} с` : `${seconds} с`;
}

/**
 * «Уже столько-то, осталось столько-то». Общий остаток — самый долгий из шагов,
 * а не их сумма: шаги идут одновременно, и складывать их остатки означало бы
 * обещать вчетверо больше, чем есть на самом деле.
 */
function statusTime(state) {
	const spent = state.startedAt ? `уже ${formatTime(Date.now() - state.startedAt)}` : '';
	const left = Math.max(0, ...Object.values(state.progress ?? {}).map(item => (item.finished ? 0 : item.eta ?? 0)));

	return left > 0 ? `${spent}, осталось ~${formatSpan(left)}` : spent;
}

function renderStatus(state) {
	running = state.running;

	$('start').disabled = running;
	$('stop').disabled = !running;
	// Отправка и обновление ходят в одну и ту же базу, и разом им нельзя:
	// сервер всё равно откажет, но мёртвая кнопка честнее отказа
	$('deploy').disabled = running;

	for (const id of ['reparse', 'retry', 'retopics', 'resummary', 'upgrade', 'serial', 'limit', 'pages', 'model',
		'first', 'packs', 'authors', 'force']) {
		$(id).disabled = running;
	}

	for (const input of $('steps').querySelectorAll('input')) {
		input.disabled = running;
	}

	if (running) {
		const active = (state.active ?? [])
			.map(key => state.steps?.find(step => step.key === key)?.name)
			.filter(Boolean)
			.map(name => name.toLowerCase());

		// Шагов сразу несколько — перечисляем все, а не выбираем из них главный
		$('statusText').textContent = active.length > 0 ? `Идёт: ${active.join(', ')}` : 'Запускаю…';
		$('statusText').className = 'update__state update__state--running';

		$('statusTime').textContent = statusTime(state);
		return;
	}

	if (state.finishedAt) {
		const ok = state.exitCode === 0;
		$('statusText').textContent = state.stopped ? 'Остановлено' : ok ? 'Готово' : `Сорвалось (код ${state.exitCode})`;
		$('statusText').className = state.stopped ? 'update__state' : `update__state update__state--${ok ? 'done' : 'failed'}`;
		$('statusTime').textContent = state.startedAt ? `за ${formatTime(state.finishedAt - state.startedAt)}` : '';
		return;
	}

	$('statusText').textContent = 'Готово к запуску';
	$('statusText').className = 'update__state';
	$('statusTime').textContent = '';
}

let timer = null;

/** Пока идёт работа, «уже столько-то» должно тикать само. */
function watchClock(state) {
	clearInterval(timer);

	if (state.running && state.startedAt) {
		timer = setInterval(() => {
			$('statusTime').textContent = statusTime(state);
		}, 1000);
	}
}

let lastState = {};

function applyState(state) {
	const was = running;
	lastState = { ...lastState, ...state };

	renderProgress(lastState);
	renderStatus(lastState);
	watchClock(lastState);

	// Работа кончилась — самое время посмотреть, сколько запросов она съела
	if (was && !running) {
		loadModels();
	}
}

function listen() {
	const source = new EventSource('/api/update/events');

	source.addEventListener('message', event => {
		const data = JSON.parse(event.data);

		if (data.type === 'log') {
			appendLog([data.line]);
			return;
		}

		if (data.type === 'progress') {
			applyState(data.state);
			return;
		}

		if (data.type === 'state') {
			// Полное состояние приходит при подключении и в конце работы:
			// лог в нём — то, что уже случилось, поэтому переписываем его целиком
			if (Array.isArray(data.state.log)) {
				$('log').textContent = data.state.log.join('\n') + (data.state.log.length > 0 ? '\n' : '');
				$('log').scrollTop = $('log').scrollHeight;
			}

			applyState(data.state);
		}
	});

	// Сервер могли перезапустить — EventSource переподключится сам, и состояние приедет заново
	source.addEventListener('error', () => {
		$('statusText').textContent = 'Нет связи с сайтом…';
	});
}

/**
 * Список моделей с расходом за сутки.
 *
 * Сколько запросов осталось, Gemini не сообщает никаким методом — расход считает
 * сама база, отмечая каждый запрос (см. src/models.js). Поэтому число обновляется
 * и во время работы: пока идёт разметка, остаток тает на глазах.
 */
async function loadModels() {
	const response = await fetch('/api/update/models');
	const info = response.ok ? await response.json() : {};

	if (!Array.isArray(info.models)) {
		// Старый сервер этого метода ещё не знает. Список моделей — не то, без чего
		// нельзя запускать обновление, поэтому просто говорим об этом и живём дальше
		$('modelHint').textContent = 'Список моделей не получен: сайт запущен из старой сборки. '
			+ 'Обновление запустится на модели, выбранной в прошлый раз; перезапустите сайт, чтобы вернуть выбор.';
		return { models: [] };
	}

	const box = $('model');
	const chosen = box.value || info.current;

	box.textContent = '';

	for (const model of info.models) {
		const option = element('option', null, `${model.title} — ${describeLimit(model)}`);
		option.value = model.id;
		option.selected = model.id === chosen;
		box.append(option);
	}

	renderModelHint(info);
	return info;
}

/** «осталось 963 из ≈1000» — или «лимит на сегодня кончился». */
function describeLimit(model) {
	if (model.unavailable) {
		return 'закрыта для этого ключа';
	}

	if (model.spentOut) {
		return 'лимит на сегодня кончился';
	}

	if (model.limit === null) {
		return `потрачено ${model.spent}, предел неизвестен`;
	}

	return `осталось ${model.left} из ${model.exact ? '' : '≈'}${model.limit} в сутки`;
}

function renderModelHint(info) {
	const model = info.models.find(item => item.id === $('model').value) ?? info.models.find(item => item.current);

	if (!model) {
		return;
	}

	if (model.unavailable) {
		$('modelHint').textContent = `Эту модель ключу не дают: «${model.refusal ?? 'отказ без объяснений'}». `
			+ 'Выберите другую — пометка снимется сама, если модель когда-нибудь ответит.';
		return;
	}

	const exact = model.exact
		? 'Предел точный: его назвал сам Gemini, когда отказал.'
		: 'Предел приблизительный, из списка в src/models.js: настоящий станет виден, когда в него упрёмся.';

	$('modelHint').textContent = `${model.note}. Потрачено сегодня: ${model.spent}. ${exact} `
		+ `Сутки считаются по тихоокеанскому времени — там Google сбрасывает квоты.`;
}

async function start() {
	const body = {
		steps: [...selected],
		options: {
			reparse: $('reparse').checked,
			retry: $('retry').checked,
			retopics: $('retopics').checked,
			resummary: $('resummary').checked,
			upgrade: $('upgrade').checked,
			serial: $('serial').checked,
			model: $('model').value,
			// Чем начинать очередь: до конца она всё равно не проходится,
			// и это выбор, что останется недоделанным (см. --first в indexer.js)
			first: $('first').value,
			limit: $('limit').value,
			pages: $('pages').value,
			packs: $('packs').value,
			authors: $('authors').value,
			// «Переделать всё заново» имеет смысл только вместе с названными паками:
			// по всей базе это значило бы переспросить пять тысяч паков разом
			force: $('force').checked && Boolean($('packs').value.trim() || $('authors').value.trim()),
		},
	};

	let data;

	try {
		const response = await fetch('/api/update/start', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});

		data = await response.json();
	} catch (error) {
		data = { error: `Сайт не ответил на запуск: ${error.message}` };
	}

	if (data.error) {
		$('statusText').textContent = data.error;
		$('statusText').className = 'update__state update__state--failed';
		return;
	}

	// Лог не трогаем: сервер уже начал новый и прислал его первой строкой через события
	applyState(data);
}

/**
 * Повторная отправка на сайт — для случая, когда прошлая не доехала. Обычное
 * обновление зовёт то же самое своим последним шагом и ни о чём не спрашивает:
 * база одна, и её изменение и есть изменение сайта.
 */
async function deploy() {
	if (!confirm('Отправить на сайт то, что дома есть, а наверху нет?')) {
		return;
	}

	let data;

	try {
		const response = await fetch('/api/update/deploy', { method: 'POST' });
		data = await response.json();
	} catch (error) {
		data = { error: `Сайт не ответил на выкладку: ${error.message}` };
	}

	if (data.error) {
		$('statusText').textContent = data.error;
		$('statusText').className = 'update__state update__state--failed';
		return;
	}

	applyState(data);
}

async function stop() {
	$('stop').disabled = true;
	await fetch('/api/update/stop', { method: 'POST' });
}

/**
 * Два листочка — общий для всех знак «скопировать»: лист поверх листа, то есть
 * «сделать второй такой же». Нарисован линиями, как и остальные значки сайта
 * (см. web/icons.js), и цвет берёт у текста кнопки.
 */
const COPY_ICON = '<rect x="9" y="9" width="11.5" height="12.5" rx="2"/>'
	+ '<path d="M15.5 5.5V5a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2H6"/>';

/** Галочка на месте листочков: нажатие, после которого ничего не изменилось, читается как несработавшее. */
const DONE_ICON = '<path d="m4.8 12.6 4.9 4.9L19.2 7"/>';

function setCopyIcon(paths) {
	$('copyLog').innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" class="icon">${paths}</svg>`;
}

/**
 * Кладёт строку в буфер обмена. Нынешний способ работает только на защищённом
 * соединении, а домашний сайт открывают по http с соседней машины — там остаётся
 * старый, через невидимое поле ввода (то же самое делает web/card.js).
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

let copyTimer = null;

/**
 * Забрать лог целиком.
 *
 * Выделять его мышью бесполезно: строк в нём тысячи, он прокручивается сам,
 * пока идёт работа, и уезжает из-под курсора. А нужен он целиком — чтобы
 * показать, на чём всё споткнулось.
 */
async function copyLog() {
	const text = $('log').textContent;

	if (!text.trim()) {
		return;
	}

	const done = await copyText(text);
	const button = $('copyLog');

	button.title = done
		? `Скопировано: ${text.split('\n').length} строк`
		: 'Скопировать не вышло: браузер не дал доступа к буферу';

	setCopyIcon(done ? DONE_ICON : COPY_ICON);
	clearTimeout(copyTimer);

	copyTimer = setTimeout(() => {
		setCopyIcon(COPY_ICON);
		button.title = 'Скопировать весь лог';
	}, 1800);
}

async function init() {
	// Кнопки оживают первыми. Всё остальное здесь ходит по сети, а любая заминка
	// там оставляла страницу с нарисованной, но мёртвой кнопкой «Запустить»
	$('start').addEventListener('click', start);
	$('stop').addEventListener('click', stop);
	$('deploy').addEventListener('click', deploy);
	$('model').addEventListener('change', () => loadModels());

	setCopyIcon(COPY_ICON);
	$('copyLog').addEventListener('click', copyLog);

	// Страница пака и страница автора приводят сюда с уже названными паками:
	// «обнови вот этот». Заполняем поля из адреса, а запускает человек сам —
	// посмотрев, что именно отмечено
	const query = new URLSearchParams(window.location.search);

	if (query.get('packs')) {
		$('packs').value = query.get('packs');
	}

	if (query.get('authors')) {
		$('authors').value = query.get('authors');
	}

	const info = await (await fetch('/api/update/steps')).json();
	steps = info.steps;

	for (const step of steps) {
		if (DEFAULT_STEPS.has(step.key)) {
			selected.add(step.key);
		}
	}

	const missing = [];

	if (!info.hasGemini) {
		missing.push('ключа Gemini (data/gemini-key.txt) — не будет процентов категорий и описаний');
	}

	if (!info.hasVkToken) {
		missing.push('ключа VK API (data/vk-token.txt) — обсуждения читаются медленнее, разбором страниц');
	}

	$('keysHint').textContent = missing.length > 0 ? `Нет ${missing.join('; нет ')}.` : 'Ключи ВК и Gemini на месте.';

	renderSteps();

	await loadModels();

	// Пока идёт работа, остаток запросов тает — раз в полминуты спрашиваем заново
	setInterval(() => {
		if (running) {
			loadModels();
		}
	}, 30000);

	$('log').addEventListener('scroll', event => {
		const node = event.target;
		logAtBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
	});

	const state = await (await fetch('/api/update/state')).json();
	$('log').textContent = state.log.join('\n');
	applyState(state);
	listen();
}

// Молча оборваться посреди подготовки страница не должна: кнопки к этому времени
// уже работают, и человеку надо сказать, чего именно не хватило
init().catch(error => {
	$('statusText').textContent = `Страница загрузилась не до конца: ${error.message}`;
	$('statusText').className = 'update__state update__state--failed';
});
