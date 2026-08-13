// Запуск индексатора со страницы обновления базы: один процесс за раз,
// его вывод раздаётся всем открытым вкладкам.
//
// Индексатор остаётся обычной программой командной строки — здесь только
// перевод галочек в его флаги и разбор того, что он печатает.

import { spawn } from 'node:child_process';
import { config, PROGRESS_PREFIX } from './config.js';
import { usageReport, chooseModel, MODELS } from './models.js';

/** Шаги в том порядке, в каком их показывает страница. Ключи совпадают с --steps=. */
export const UPDATE_STEPS = [
	{
		key: 'vk',
		name: 'Собрать ссылки из ВК',
		hint: 'Читает обсуждения и добавляет в базу новые файлы паков.',
	},
	{
		key: 'parse',
		name: 'Разобрать новые паки',
		hint: 'Достаёт из архива название, авторов, темы и логотип. Самый долгий шаг.',
	},
	{
		key: 'stats',
		name: 'Статистика и сложность',
		hint: 'Обновляет число игр, доли попыток ответа и правильных ответов — у всех паков заново. '
			+ 'Стоит запускать регулярно, но это пять тысяч запросов к чужому сервису и полчаса времени.',
	},
	{
		key: 'statsnew',
		name: 'Статистика только у новых',
		hint: 'То же самое, но спрашивает лишь про паки, у которых статистики нет вовсе, — про сегодняшние. '
			+ 'Десятки запросов вместо тысяч: после разбора новых паков обычно нужен именно он. '
			+ 'Вместе с шагом выше не идёт: тот и так спрашивает про всех.',
	},
	{
		key: 'topics',
		name: 'Проценты категорий',
		hint: 'Спрашивает Gemini, о чём каждая тема: аниме, игры, кино, мультики, книги, музыка, прочее. '
			+ 'Уже размеченные паки пропускаются, заново их спрашивает только галочка ниже.',
	},
	{
		key: 'summary',
		name: 'Краткие описания',
		hint: 'Одна строка про то, что в паке: «Вселенная Гарри Поттера», «Логотипы компаний». '
			+ 'Составляется всем разобранным пакам, в том числе тем, под которыми автор '
			+ 'уже написал своё описание: это разные вещи и стоят они на карточке порознь. '
			+ 'Второй раз спрашивается только по галочке ниже.',
	},
	{
		key: 'logos',
		name: 'Докачать логотипы',
		hint: 'Только для паков, у которых логотипа почему-то не оказалось.',
	},
	{
		key: 'specials',
		name: 'Досчитать спецвопросы',
		hint: 'Аукционы, коты в мешке и вопросы без риска — у паков, разобранных до того, как их научились считать.',
	},
	{
		key: 'recalc',
		name: 'Пересчитать уровни и ярлыки',
		hint: 'Без сети: применяет новые пороги из настроек к тому, что уже в базе.',
	},
];

const STEP_KEYS = new Set(UPDATE_STEPS.map(step => step.key));

/** Галочки «переделать заново» и их флаги. */
const OPTIONS = {
	reparse: '--reparse',
	retopics: '--retopics',
	resummary: '--resummary',
	retry: '--retry',
	upgrade: '--upgrade',
	serial: '--serial',
};

/** Сколько строк вывода держим, чтобы показать их вкладке, открытой посреди работы. */
const LOG_LIMIT = 3000;

const state = {
	running: false,
	steps: [],
	// Шагов, идущих прямо сейчас, теперь бывает несколько: индексатор ведёт их
	// разом, а не лесенкой (см. src/indexer.js). Прежнее одиночное «current»
	// осталось бы враньём — оно показывало бы один шаг из пяти работающих.
	active: [],
	progress: {},
	startedAt: null,
	finishedAt: null,
	exitCode: null,
	stopped: false,
	error: null,
	log: [],
};

let child = null;
const clients = new Set();

/** Что показать вкладке, которая только что подключилась. */
export function updateState() {
	return {
		running: state.running,
		steps: state.steps,
		active: state.active,
		progress: state.progress,
		startedAt: state.startedAt,
		finishedAt: state.finishedAt,
		exitCode: state.exitCode,
		stopped: state.stopped,
		error: state.error,
		log: state.log,
		availableSteps: UPDATE_STEPS,
	};
}

function send(event) {
	const payload = `data: ${JSON.stringify(event)}\n\n`;

	for (const client of clients) {
		client.write(payload);
	}
}

/** Подписывает вкладку на события. Возвращает функцию отписки. */
export function subscribe(response) {
	response.writeHead(200, {
		'Content-Type': 'text/event-stream; charset=utf-8',
		'Cache-Control': 'no-cache',
		Connection: 'keep-alive',
		// Иначе прокси и браузер могут придержать первые строки у себя
		'X-Accel-Buffering': 'no',
	});

	response.write(`data: ${JSON.stringify({ type: 'state', state: updateState() })}\n\n`);
	clients.add(response);

	return () => clients.delete(response);
}

function pushLog(line) {
	state.log.push(line);

	if (state.log.length > LOG_LIMIT) {
		state.log.splice(0, state.log.length - LOG_LIMIT);
	}

	send({ type: 'log', line });
}

/**
 * Строка от индексатора: обычный вывод идёт в лог, а отчёт о ходе работы
 * (см. PROGRESS_PREFIX) — в полоски прогресса.
 */
function handleLine(line) {
	if (!line.startsWith(PROGRESS_PREFIX)) {
		pushLog(line);
		return;
	}

	let event;

	try {
		event = JSON.parse(line.slice(PROGRESS_PREFIX.length));
	} catch {
		return;
	}

	if (event.plan) {
		// Названия берём свои: на странице шаги должны называться так же, как в галочках
		state.steps = event.plan.map(step => ({
			key: step.key,
			name: UPDATE_STEPS.find(known => known.key === step.key)?.name ?? step.name,
		}));

		state.progress = {};
		state.active = [];
	} else if (event.state === 'start') {
		state.active = [...new Set([...state.active, event.step])];
	} else if (event.state === 'done') {
		state.progress[event.step] = { ...state.progress[event.step], finished: true };
		state.active = state.active.filter(key => key !== event.step);
	} else if (event.step) {
		state.progress[event.step] = {
			...state.progress[event.step],
			done: event.done,
			total: event.total,
			// Сколько осталось по нынешнему темпу и может ли работы ещё прибавиться:
			// у шага, которому подносят, «всего» на месте не стоит
			eta: event.eta ?? null,
			growing: event.growing ?? false,
		};
	}

	send({ type: 'progress', state: { steps: state.steps, active: state.active, progress: state.progress } });
}

/** Разрезает поток на строки: одна порция данных редко совпадает со строкой. */
function readLines(stream) {
	let tail = '';

	stream.setEncoding('utf8');
	stream.on('data', chunk => {
		const lines = (tail + chunk).split(/\r?\n/);
		tail = lines.pop() ?? '';

		for (const line of lines) {
			handleLine(line);
		}
	});

	stream.on('end', () => {
		if (tail) {
			handleLine(tail);
		}
	});
}

/** Целое из формы: пустое поле означает «без ограничения». */
function positive(value) {
	const number = Number.parseInt(value, 10);
	return Number.isFinite(number) && number > 0 ? number : null;
}

/**
 * Запускает индексатор с выбранными шагами.
 * @param {{steps: string[], options: object}} request
 */
export function startUpdate(request) {
	if (state.running) {
		throw new Error('Обновление уже идёт');
	}

	const steps = (request.steps ?? []).filter(key => STEP_KEYS.has(key));

	if (steps.length === 0) {
		throw new Error('Не выбрано ни одного шага');
	}

	const options = request.options ?? {};
	const args = ['--no-warnings', config.indexerPath, `--steps=${steps.join(',')}`];

	// Выбранная модель запоминается, а не уходит одним ключом: тем же выбором
	// должен пользоваться ночной обход, который никто не запускает руками
	if (options.model && MODELS.some(model => model.id === options.model)) {
		chooseModel(options.model);
	}

	for (const [name, flag] of Object.entries(OPTIONS)) {
		if (options[name]) {
			args.push(flag);
		}
	}

	const limit = positive(options.limit);
	const pages = positive(options.pages);

	if (limit) {
		args.push(`--limit=${limit}`);
	}

	if (pages) {
		args.push(`--pages=${pages}`);
	}

	state.running = true;
	state.steps = steps.map(key => ({ key, name: UPDATE_STEPS.find(s => s.key === key).name }));
	state.active = [];
	state.progress = {};
	state.startedAt = Date.now();
	state.finishedAt = null;
	state.exitCode = null;
	state.stopped = false;
	state.error = null;
	state.log = [];

	child = spawn(process.execPath, args, {
		cwd: config.rootPath,
		env: { ...process.env, FIREPACKS_GUI: '1' },
	});

	pushLog(`> node ${args.slice(1).map(a => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`);

	readLines(child.stdout);
	readLines(child.stderr);

	child.on('error', error => {
		state.error = error.message;
		pushLog(`Не вышло запустить индексатор: ${error.message}`);
	});

	// Убитый процесс приходит сюда без кода выхода, зато с сигналом, — для страницы
	// это не ошибка, а нажатая кнопка «Остановить».
	child.on('close', (code, signal) => {
		child = null;
		state.running = false;
		state.active = [];
		state.exitCode = code;
		state.finishedAt = Date.now();

		if (state.stopped) {
			pushLog('Остановлено. Всё, что успело посчитаться, уже в базе.');
		} else if (code !== 0) {
			pushLog(`Индексатор завершился с кодом ${code ?? signal}.`);
		}

		send({ type: 'state', state: updateState() });
	});

	send({ type: 'state', state: updateState() });

	return updateState();
}

/**
 * Модели и расход запросов для страницы обновления. Считается на каждый запрос
 * заново: расход растёт прямо во время работы, и вкладка должна видеть свежее
 * число, а не то, что было при открытии.
 */
export function updateModels() {
	return usageReport();
}

/** Останавливает работу. Пак, который разбирается прямо сейчас, просто не досчитается. */
export function stopUpdate() {
	if (!child) {
		throw new Error('Обновление не запущено');
	}

	state.stopped = true;
	pushLog('Останавливаю…');
	child.kill();

	return updateState();
}
