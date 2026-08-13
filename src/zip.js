// Чтение одного файла из ZIP-архива по сети через range-запросы.
// Позволяет достать content.xml из пака на 100 МБ, скачав пару десятков килобайт.

import zlib from 'node:zlib';
import { config } from './config.js';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD64_LOCATOR_SIGNATURE = 0x07064b50;
const EOCD64_SIGNATURE = 0x06064b50;
const MAX_EOCD_SIZE = 65557;

/**
 * Сколько лишнего берём за локальным заголовком в надежде накрыть его целиком
 * (см. read). Поле extra там обычно пустое или в несколько десятков байт;
 * четверти килобайта хватает всегда, а стоит она нисколько.
 */
const LOCAL_EXTRA_SLACK = 256;

/** ВК отдаёт HTML вместо файла, когда документ удалён или скрыт. */
export class DeadLinkError extends Error {
	constructor() {
		super('ссылка недоступна: документ удалён или скрыт');
		this.name = 'DeadLinkError';
	}
}

async function fetchRange(url, from, to) {
	const response = await fetch(url, {
		headers: {
			'User-Agent': config.userAgent,
			Range: `bytes=${from}-${to}`,
		},
	});

	if (response.status !== 206 && response.status !== 200) {
		throw new Error(`HTTP ${response.status} при чтении ${from}-${to}`);
	}

	return Buffer.from(await response.arrayBuffer());
}

/**
 * Хвост файла одним запросом — вместе с его полным размером.
 *
 * Обычный диапазон «от такого-то байта» тут не годится: чтобы посчитать, где
 * начинается хвост, надо сперва узнать размер, а это ещё один поход к серверу.
 * Запись «bytes=-N» просит последние N байт, не зная длины файла вовсе, а размер
 * приезжает в ответном content-range: «bytes 58836106-58901662/58901663».
 *
 * Ради одного сбережённого запроса это не стоило бы делать, но у ВК каждый поход
 * стоит от полусекунды до трёх независимо от того, байт в нём или сто килобайт
 * (см. комментарий к parsePackages в indexer.js). Здесь экономится не трафик,
 * а именно поход.
 */
async function fetchTail(url, length) {
	const response = await fetch(url, {
		headers: { 'User-Agent': config.userAgent, Range: `bytes=-${length}` },
	});

	if ((response.headers.get('content-type') ?? '').startsWith('text/html')) {
		throw new DeadLinkError();
	}

	if (response.status !== 206 && response.status !== 200) {
		throw new Error(`HTTP ${response.status} при чтении хвоста файла`);
	}

	const buffer = Buffer.from(await response.arrayBuffer());
	const contentRange = response.headers.get('content-range');
	const match = contentRange ? /\/(\d+)\s*$/.exec(contentRange) : null;

	// Диапазон поняли: пришёл ровно хвост, и размер сказали в заголовке
	if (response.status === 206 && match) {
		const totalSize = Number(match[1]);

		if (Number.isFinite(totalSize) && totalSize >= buffer.length) {
			return { buffer, totalSize, tailStart: totalSize - buffer.length };
		}
	}

	// Диапазон не поняли и прислали файл целиком. Лишний трафик, но искать
	// оглавление в нём можно там же, где и в хвосте, — просто хвост тут весь файл.
	return { buffer, totalSize: buffer.length, tailStart: 0 };
}

/** Возвращает размер файла, не скачивая его. */
export async function getRemoteSize(url) {
	const response = await fetch(url, {
		headers: { 'User-Agent': config.userAgent, Range: 'bytes=0-0' },
	});

	if ((response.headers.get('content-type') ?? '').startsWith('text/html')) {
		throw new DeadLinkError();
	}

	if (response.status === 206) {
		const contentRange = response.headers.get('content-range');

		if (contentRange) {
			const size = parseInt(contentRange.split('/')[1], 10);

			if (Number.isFinite(size)) {
				return size;
			}
		}
	}

	if (response.status === 200) {
		const length = response.headers.get('content-length');

		if (length) {
			return parseInt(length, 10);
		}
	}

	throw new Error(`не удалось узнать размер файла (HTTP ${response.status})`);
}

function readCentralDirectoryLocation(tail, tailStart, totalSize) {
	let eocd = -1;

	for (let i = tail.length - 22; i >= 0; i--) {
		if (tail.readUInt32LE(i) === EOCD_SIGNATURE) {
			eocd = i;
			break;
		}
	}

	if (eocd < 0) {
		throw new Error('это не ZIP-архив');
	}

	let size = tail.readUInt32LE(eocd + 12);
	let offset = tail.readUInt32LE(eocd + 16);

	// ZIP64: большие архивы хранят реальные значения в отдельной записи
	if (offset === 0xffffffff || size === 0xffffffff) {
		for (let i = eocd - 20; i >= 0; i--) {
			if (tail.readUInt32LE(i) === EOCD64_LOCATOR_SIGNATURE) {
				const eocd64Offset = Number(tail.readBigUInt64LE(i + 8));
				const local = eocd64Offset - tailStart;

				if (local >= 0 && local + 56 <= tail.length && tail.readUInt32LE(local) === EOCD64_SIGNATURE) {
					size = Number(tail.readBigUInt64LE(local + 40));
					offset = Number(tail.readBigUInt64LE(local + 48));
				}

				break;
			}
		}
	}

	if (!Number.isFinite(offset) || offset >= totalSize) {
		throw new Error('повреждённое оглавление архива');
	}

	return { size, offset };
}

function parseCentralDirectory(buffer) {
	const entries = [];
	let position = 0;

	while (position + 46 <= buffer.length && buffer.readUInt32LE(position) === CENTRAL_SIGNATURE) {
		const method = buffer.readUInt16LE(position + 10);
		const compressedSize = buffer.readUInt32LE(position + 20);
		const nameLength = buffer.readUInt16LE(position + 28);
		const extraLength = buffer.readUInt16LE(position + 30);
		const commentLength = buffer.readUInt16LE(position + 32);
		const localOffset = buffer.readUInt32LE(position + 42);
		const name = buffer.subarray(position + 46, position + 46 + nameLength).toString('utf8');

		entries.push({ name, method, compressedSize, localOffset });
		position += 46 + nameLength + extraLength + commentLength;
	}

	return entries;
}

/**
 * Читает оглавление удалённого архива. Дальше из него можно доставать файлы
 * по одному, не перечитывая оглавление заново.
 * @param {string} url ссылка на архив
 */
export async function openRemoteZip(url) {
	const { buffer: tail, totalSize, tailStart } = await fetchTail(url, MAX_EOCD_SIZE);

	if (totalSize > config.maxPackageSize) {
		throw new Error(`пак слишком большой: ${Math.round(totalSize / 1024 / 1024)} МБ`);
	}

	const location = readCentralDirectoryLocation(tail, tailStart, totalSize);

	const central = location.offset >= tailStart
		? tail.subarray(location.offset - tailStart, location.offset - tailStart + location.size)
		: await fetchRange(url, location.offset, location.offset + location.size - 1);

	const entries = parseCentralDirectory(central);

	/** Ищет файл по имени. Регистр не важен, percent-кодировка тоже. */
	const find = name => {
		const variants = new Set();

		for (const candidate of [name, encodeURIComponent(name), decodeSafe(name)]) {
			variants.add(candidate.toLowerCase());
			variants.add(candidate.toLowerCase().replace(/%20/g, '+'));
		}

		return entries.find(entry => variants.has(entry.name.toLowerCase()))
			?? entries.find(entry => variants.has(decodeSafe(entry.name).toLowerCase()));
	};

	/**
	 * Скачивает и распаковывает один файл.
	 *
	 * Данные лежат сразу за локальным заголовком, а его длина заранее неизвестна:
	 * он повторяет имя файла и несёт собственное extra-поле, которое не обязано
	 * совпадать с тем, что записано в оглавлении. Честный порядок — прочитать
	 * заголовок, узнать длины, потом сходить за данными, — стоит двух походов
	 * к серверу, и это ровно вдвое дороже самих данных: у ВК поход стоит секунду
	 * с лишним независимо от размера.
	 *
	 * Поэтому берём сразу с запасом: заголовок с полем extra любого разумного
	 * размера плюс сами данные. Настоящие длины читаются уже из полученного куска,
	 * и данные из него же и вырезаются. Если запаса всё-таки не хватило —
	 * дочитываем недостающий хвост вторым запросом, то есть как раньше.
	 */
	const read = async entry => {
		if (entry.compressedSize === 0) {
			return Buffer.alloc(0);
		}

		const guess = 30 + Buffer.byteLength(entry.name, 'utf8') + LOCAL_EXTRA_SLACK;
		const head = await fetchRange(url, entry.localOffset, entry.localOffset + guess + entry.compressedSize - 1);

		if (head.length < 30) {
			throw new Error('обрезанный локальный заголовок');
		}

		const dataOffset = 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
		let raw = head.subarray(dataOffset, dataOffset + entry.compressedSize);

		if (raw.length < entry.compressedSize) {
			const from = entry.localOffset + dataOffset + raw.length;
			const rest = await fetchRange(url, from, entry.localOffset + dataOffset + entry.compressedSize - 1);
			raw = Buffer.concat([raw, rest]);
		}

		return entry.method === 0 ? raw : zlib.inflateRawSync(raw);
	};

	return { totalSize, entries, find, read };
}

function decodeSafe(value) {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

/**
 * Достаёт один файл из удалённого ZIP-архива.
 * @param {string} url ссылка на архив
 * @param {string} entryName имя файла внутри архива, регистр не важен
 */
export async function readRemoteZipEntry(url, entryName) {
	const archive = await openRemoteZip(url);
	const entry = archive.find(entryName);

	if (!entry) {
		throw new Error(`в архиве нет ${entryName}`);
	}

	return { content: await archive.read(entry), totalSize: archive.totalSize, fileCount: archive.entries.length };
}
