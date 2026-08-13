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

/** Полоски выполнения: по одной на шаг нынешнего запуска. */
function renderProgress(state) {
	const box = $('progress');
	box.textContent = '';

	for (const step of state.steps ?? []) {
		const item = state.progress?.[step.key] ?? {};
		const total = item.total ?? 0;
		const done = item.finished ? total : item.done ?? 0;
		const active = state.current === step.key;

		const row = element('div', `progress__row${active ? ' progress__row--active' : ''}`);
		row.append(element('span', 'progress__name', step.name));

		const bar = element('div', 'progress__bar');
		const fill = element('div', 'progress__fill');
		fill.style.width = total > 0 ? `${Math.round((done / total) * 100)}%` : (item.finished ? '100%' : '0%');
		bar.append(fill);
		row.append(bar);

		const state_ = item.finished ? 'готово' : total > 0 ? `${done} из ${total}` : active ? 'работаю' : 'в очереди';
		row.append(element('span', 'progress__count', state_));

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

function renderStatus(state) {
	running = state.running;

	$('start').disabled = running;
	$('stop').disabled = !running;

	for (const id of ['reparse', 'retry', 'retopics', 'resummary', 'limit', 'pages']) {
		$(id).disabled = running;
	}

	for (const input of $('steps').querySelectorAll('input')) {
		input.disabled = running;
	}

	if (running) {
		const current = state.steps?.find(step => step.key === state.current);
		$('statusText').textContent = current ? `Идёт: ${current.name.toLowerCase()}` : 'Запускаю…';
		$('statusText').className = 'update__state update__state--running';
		$('statusTime').textContent = state.startedAt ? `уже ${formatTime(Date.now() - state.startedAt)}` : '';
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
			$('statusTime').textContent = `уже ${formatTime(Date.now() - state.startedAt)}`;
		}, 1000);
	}
}

let lastState = {};

function applyState(state) {
	lastState = { ...lastState, ...state };

	renderProgress(lastState);
	renderStatus(lastState);
	watchClock(lastState);
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

async function start() {
	const body = {
		steps: [...selected],
		options: {
			reparse: $('reparse').checked,
			retry: $('retry').checked,
			retopics: $('retopics').checked,
			resummary: $('resummary').checked,
			limit: $('limit').value,
			pages: $('pages').value,
		},
	};

	const response = await fetch('/api/update/start', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});

	const data = await response.json();

	if (data.error) {
		$('statusText').textContent = data.error;
		$('statusText').className = 'update__state update__state--failed';
		return;
	}

	// Лог не трогаем: сервер уже начал новый и прислал его первой строкой через события
	applyState(data);
}

async function stop() {
	$('stop').disabled = true;
	await fetch('/api/update/stop', { method: 'POST' });
}

async function init() {
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

	$('start').addEventListener('click', start);
	$('stop').addEventListener('click', stop);

	$('log').addEventListener('scroll', event => {
		const node = event.target;
		logAtBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
	});

	const state = await (await fetch('/api/update/state')).json();
	$('log').textContent = state.log.join('\n');
	applyState(state);
	listen();
}

init();
