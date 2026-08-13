// Запуск индексатора со страницы обновления базы: один процесс за раз,
// его вывод раздаётся всем открытым вкладкам.
//
// Индексатор остаётся обычной программой командной строки — здесь только
// перевод галочек в его флаги и разбор того, что он печатает.

import { spawn } from 'node:child_process';
import { config, PROGRESS_PREFIX } from './config.js';

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
		hint: 'Обновляет число игр, доли попыток ответа и правильных ответов. Стоит запускать регулярно.',
	},
	{
		key: 'topics',
		name: 'Проценты категорий',
		hint: 'Спрашивает Gemini, о чём каждая тема: аниме, игры, кино, мультики, музыка. '
			+ 'Уже размеченные паки пропускаются, заново их спрашивает только галочка ниже.',
	},
	{
		key: 'summary',
		name: 'Краткие описания',
		hint: 'Одна строка про то, что в паке: «Вселенная Гарри Поттера», «Логотипы компаний». '
			+ 'Паки с готовым описанием пропускаются.',
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
};

/** Сколько строк вывода держим, чтобы показать их вкладке, открытой посреди работы. */
const LOG_LIMIT = 3000;

const state = {
	running: false,
	steps: [],
	current: null,
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
		current: state.current,
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
	} else if (event.state === 'start') {
		state.current = event.step;
	} else if (event.state === 'done') {
		state.progress[event.step] = { ...state.progress[event.step], finished: true };
	} else if (event.step) {
		state.progress[event.step] = { done: event.done, total: event.total };
	}

	send({ type: 'progress', state: { steps: state.steps, current: state.current, progress: state.progress } });
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
	state.current = null;
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
		state.current = null;
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
