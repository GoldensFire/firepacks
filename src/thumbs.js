// Уменьшенные обложки для карточек.
//
// Зачем. Логотип внутри пака — это картинка, которую автор рисовал для заставки:
// обычная величина в базе — 1200×1200 и 180 КБ, а бывает и мегабайт. На карточке
// она показывается квадратиком 72×72, и на страницу их приходит два десятка:
// четыре мегабайта, чтобы нарисовать площадь почтовой марки. Пока их не было,
// обложки просто не успевали появиться — за это их и ругали.
//
// Уменьшенная копия того же логотипа весит 1–4 КБ, то есть страница обложек
// становится легче раз в сорок пять. Считается копия один раз и навсегда:
// имя файла логотипа привязано к номеру пака и не меняется, поэтому и копия
// живёт рядом с оригиналом до тех пор, пока её не удалят руками.
//
// Своей библиотеки для картинок в проекте нет и заводить её не хочется (весь
// SIFirePacks обходится тем, что уже есть в Node), поэтому уменьшает ImageMagick
// или ffmpeg — то, что и так стоит у любого, кто возится с паками. Нет ни того,
// ни другого — сайт просто отдаёт оригинал: медленно, но правильно.

import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { config } from './config.js';
import { thumbName } from './settings.js';

/** Сторона квадрата. Вдвое больше, чем на карточке: под экраны с удвоением точек. */
const SIZE = 144;

/** Сколько картинок уменьшать разом. Больше — только зря греется процессор. */
const PARALLEL = 4;

// Склад один на всех: тот же, из которого берёт готовые копии сборка для
// Cloudflare (см. config.thumbsPath и scripts/build-web.js). До этого домашний
// сайт держал свой в data/logos/thumbs и считал заново то, что уже было посчитано
// выкладкой, — а у паков, чьи оригиналы остались в облаке ночного обхода,
// не показывал обложку вовсе.
const thumbsPath = config.thumbsPath;

/**
 * Чем уменьшать. Ищется один раз при первом обращении: спрашивать систему
 * про каждую картинку незачем, а решать заранее нельзя — сайт запускается
 * и там, где нет ни того, ни другого.
 */
let tool;

/**
 * Кого спрашивать и в каком порядке.
 *
 * «convert» — это тот же ImageMagick, только шестой версии: в семёрке всё
 * собрано под именем magick, а до неё у каждой команды было своё имя. Своё
 * имя ему нужно потому, что именно шестая лежит в готовых образах Linux,
 * на которых идёт ночной обход, — а доводы у неё те же самые, слово в слово.
 *
 * В Windows его не спрашиваем вовсе, и это не придирка: convert.exe есть
 * в самой системе — он превращает файловую систему FAT в NTFS. Найдя его,
 * мы бы решили, что уменьшать есть чем, и молча не уменьшили ни одной обложки,
 * вместо того чтобы честно перейти к ffmpeg.
 */
const TOOLS = process.platform === 'win32' ? ['magick', 'ffmpeg'] : ['magick', 'convert', 'ffmpeg'];

function findTool() {
	if (tool !== undefined) {
		return tool;
	}

	for (const candidate of TOOLS) {
		try {
			// -version у обоих; важно лишь то, что программа нашлась и запустилась
			execFileSync(candidate, ['-version'], { stdio: 'ignore', timeout: 10000 });
			tool = candidate;
			return tool;
		} catch {
			// пробуем следующую
		}
	}

	tool = null;
	console.log('Уменьшать обложки нечем (нет ни ImageMagick, ни ffmpeg) — отдаём как есть.');
	return tool;
}

const run = (file, args) => new Promise((resolve, reject) => {
	execFile(file, args, { timeout: 30000 }, error => (error ? reject(error) : resolve()));
});

/**
 * Команда уменьшения. У обоих одна задача — вписать картинку в квадрат SIZE×SIZE
 * по короткой стороне и обрезать лишнее, как это делает object-fit: cover
 * в стилях карточки.
 *
 * Формат записи оба выбирают по расширению target — а оно всегда .avif
 * (см. thumbName в settings.js), и обе половины проекта уменьшают одинаково.
 *
 * Качество 50 выглядит низким только на слух: у AVIF своя шкала, и на квадрате
 * 144×144 разницы с webp на 82 не видно даже при увеличении вдвое — а весит
 * копия при этом на треть меньше.
 *
 * Первый кадр берётся явно ([0] у ImageMagick): обложки бывают анимированными
 * гифками, и без этого на выходе оказывалась вся анимация целиком.
 */
function command(source, target) {
	if (tool === 'magick' || tool === 'convert') {
		return [tool, [
			`${source}[0]`,
			'-resize', `${SIZE}x${SIZE}^`,
			'-gravity', 'center',
			'-extent', `${SIZE}x${SIZE}`,
			'-quality', '50',
			target,
		]];
	}

	return ['ffmpeg', [
		'-v', 'error', '-y',
		'-i', source,
		'-frames:v', '1',
		'-vf', `scale=${SIZE}:${SIZE}:force_original_aspect_ratio=increase,crop=${SIZE}:${SIZE}`,
		target,
	]];
}

/** Уже считающиеся копии: два запроса на одну картинку ждут один и тот же результат. */
const inFlight = new Map();
let running = 0;
const waiting = [];

/** Простая очередь: держит число одновременных запусков в пределах PARALLEL. */
function schedule(task) {
	return new Promise((resolve, reject) => {
		const start = () => {
			running++;

			task().then(resolve, reject).finally(() => {
				running--;
				waiting.shift()?.();
			});
		};

		if (running < PARALLEL) {
			start();
		} else {
			waiting.push(start);
		}
	});
}

/**
 * Кладёт в target уменьшенную копию source. Формат выбирается по расширению
 * target, папка под него создаётся. Возвращает, получилось ли: не получиться
 * может по двум причинам — уменьшать нечем или картинка не по зубам тому,
 * что нашлось. Обе не смертельны, и обоим, кто сюда ходит, есть чем ответить.
 *
 * Одновременных запусков не больше PARALLEL, кто бы ни звал.
 */
export function resizeInto(source, target) {
	if (!findTool()) {
		return Promise.resolve(false);
	}

	return schedule(async () => {
		const directory = path.dirname(target);
		fs.mkdirSync(directory, { recursive: true });

		// Пишем во временный файл и переименовываем: иначе оборванный на середине
		// запуск оставит обрезок, который потом будет считаться готовой копией.
		//
		// Расширение у временного файла обязано совпадать с расширением копии:
		// и ImageMagick, и ffmpeg выбирают формат записи по нему, и с каким-нибудь
		// .tmp на конце оба молча складывают исходный PNG под именем копии — вес
		// выходил в двадцать пять раз больше обещанного, а Content-Type врал.
		const temporary = path.join(directory, `.tmp-${process.pid}-${path.basename(target)}`);

		try {
			const [file, args] = command(source, temporary);
			await run(file, args);
			fs.renameSync(temporary, target);
			return true;
		} catch {
			fs.rmSync(temporary, { force: true });
			return false;
		}
	});
}

/**
 * Путь к уменьшенной копии обложки. Если её ещё нет — считает.
 * Возвращает null, когда уменьшать нечем или не получилось: тогда сайт
 * отдаёт оригинал, и единственная разница — вес страницы.
 *
 * @param {string} logoFile имя файла в папке логотипов, например «511.jpg»
 */
export async function ensureThumb(logoFile) {
	const source = path.join(config.logosPath, logoFile);
	const target = path.join(thumbsPath, thumbName(logoFile));

	if (fs.existsSync(target)) {
		return target;
	}

	if (!fs.existsSync(source)) {
		return null;
	}

	if (inFlight.has(target)) {
		return inFlight.get(target);
	}

	const job = resizeInto(source, target)
		.then(done => (done ? target : null))
		.finally(() => inFlight.delete(target));

	inFlight.set(target, job);
	return job;
}
