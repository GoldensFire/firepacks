// Как шаг перемалывает свою очередь: несколько работников разом, добавка
// на ходу и ещё одна попытка после обрыва.
//
// Общее у всех шагов, а не забота каждого порознь. Полосы идут одновременно
// (см. шапку src/indexer.js), и «очередь может прибыть, пока я работаю» —
// свойство самого устройства обхода: разбор берёт паки, которые обход ВК ещё
// только находит, статистика и модель — те, что разбор ещё только разбирает.

import { DeadLinkError } from '../zip.js';
import { hasVkApi, refreshDocumentUrl } from '../vkapi.js';
import { limit, outOfTime } from './options.js';
import { track } from './progress.js';
import { isRunning, STEPS } from './steps.js';
import { updateUrl } from './store.js';

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Прогоняет список через несколько одновременных работников.
 *
 * Порядок выполнения при этом теряется, и полагаться на него нельзя: строки
 * базы друг от друга не зависят, а вот нумерация в выводе считается не по месту
 * в очереди, а по числу законченных, — иначе номера скакали бы взад-вперёд.
 */
async function runPool(items, jobs, worker, stop = () => false) {
	let next = 0;

	const workers = Array.from({ length: Math.min(jobs, items.length) }, async () => {
		while (next < items.length && !stop()) {
			await worker(items[next++]);
		}
	});

	await Promise.all(workers);
}

/**
 * Полоса работы, у которой работа может прибывать по ходу дела.
 *
 * Шаги теперь идут одновременно, и очередь шага уже нельзя посчитать один раз
 * в начале: разбор берёт паки, которые обход ВК ещё только находит, статистика
 * и модель — те, что разбор ещё только разбирает. Поэтому очередь спрашивается
 * у базы заново, пока есть кому её пополнять: `growing` отвечает, работают ли
 * ещё те шаги, что кормят этот. Как только они закончились и очередь пуста —
 * закончился и этот.
 *
 * `seen` нужен не для порядка, а по существу: статистика перезапрашивает всех
 * разобранных паков, и без памяти о том, кого уже спросили в этот заход, второй
 * запрос к базе вернул бы те же пять тысяч по второму кругу.
 *
 * `group` — необязательный делитель очереди на пачки: с ним работник берёт
 * не строку, а список строк. Нужен шагу «Всё о паке», где несколько паков
 * уезжают к модели одним запросом (см. groupForAnalysis в src/indexer/marking.js).
 */
export async function drain({ step, jobs, take, work, group = null, stop = () => false }) {
	const bar = track(step);
	const seen = new Set();

	// Отпущенное время кончается для всех шагов разом и проверяется здесь одним
	// местом, а не в каждом stop по отдельности: срок дан обходу целиком,
	// и «статистика доработает, а разметка нет» было бы правилом ниоткуда
	const done = () => stop() || outOfTime();

	// Кто может подкинуть работы этому шагу, записано в STEPS одним местом (feeds),
	// чтобы «разбору подносит обход ВК» не приходилось помнить в двух файлах
	const feeds = STEPS.find(item => item.key === step)?.feeds ?? [];
	const growing = () => feeds.some(isRunning);

	let taken = 0;

	while (!done()) {
		const room = limit === Infinity ? Infinity : limit - taken;

		if (room <= 0) {
			return;
		}

		bar.growing = growing();

		const batch = take()
			.filter(row => !seen.has(row.id))
			.slice(0, room === Infinity ? undefined : room);

		if (batch.length === 0) {
			if (!growing()) {
				return;
			}

			// Полоса опустела, но кормящий шаг ещё работает: ждём добавки.
			// Секунда — не темп опроса базы, а верхняя граница простоя: запрос
			// этот местный и стоит миллисекунды.
			await sleep(1000);
			continue;
		}

		for (const row of batch) {
			seen.add(row.id);
		}

		taken += batch.length;
		bar.expand(batch.length);

		// Работу можно раздавать не по строке, а пачками: шаг «Всё о паке»
		// спрашивает у Gemini сразу несколько паков одним запросом, и работник
		// там берёт не пак, а пачку паков (см. group в refreshAnalysis)
		// Без group работник берёт строку, как и раньше; с ним — сразу пачку строк
		const units = group ? group(batch) : batch;

		await runPool(units, jobs, async unit => {
			await work(unit, bar);
			bar.tick(Array.isArray(unit) ? unit.length : 1);
		}, done);
	}
}

/** Обрыв соединения — обычное дело на больших файлах, стоит просто попробовать ещё раз. */
function isNetworkGlitch(error) {
	return /terminated|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i.test(error.message);
}

export async function retryNetwork(action, attempts = 3) {
	let lastError = null;

	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			return await action();
		} catch (error) {
			lastError = error;

			if (!isNetworkGlitch(error) || attempt === attempts) {
				throw error;
			}

			await sleep(2000 * attempt);
		}
	}

	throw lastError;
}

/**
 * Ссылки ВК умирают, а полученные через API ещё и протухают по времени.
 * Если есть ключ — просим у ВК свежую ссылку и повторяем попытку один раз.
 */
export async function withFreshUrl(row, action) {
	try {
		return await action(row.url);
	} catch (error) {
		if (!(error instanceof DeadLinkError) || !hasVkApi()) {
			throw error;
		}

		const fresh = await refreshDocumentUrl(row.source_key).catch(() => null);

		if (!fresh || fresh === row.url) {
			throw error;
		}

		updateUrl.run(fresh, row.id);
		return action(fresh);
	}
}
