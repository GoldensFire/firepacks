// Чтение одного файла из ZIP-архива по сети через range-запросы.
// Позволяет достать content.xml из пака на 100 МБ, скачав пару десятков килобайт.

import zlib from 'node:zlib';
import { config } from './config.js';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD64_LOCATOR_SIGNATURE = 0x07064b50;
const EOCD64_SIGNATURE = 0x06064b50;
const MAX_EOCD_SIZE = 65557;

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
	const totalSize = await getRemoteSize(url);

	if (totalSize > config.maxPackageSize) {
		throw new Error(`пак слишком большой: ${Math.round(totalSize / 1024 / 1024)} МБ`);
	}

	const tailLength = Math.min(MAX_EOCD_SIZE, totalSize);
	const tailStart = totalSize - tailLength;
	const tail = await fetchRange(url, tailStart, totalSize - 1);

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

	/** Скачивает и распаковывает один файл. */
	const read = async entry => {
		// Локальный заголовок хранит собственные длины имени и extra-поля
		const localHeader = await fetchRange(url, entry.localOffset, entry.localOffset + 29);
		const nameLength = localHeader.readUInt16LE(26);
		const extraLength = localHeader.readUInt16LE(28);
		const dataStart = entry.localOffset + 30 + nameLength + extraLength;

		const raw = await fetchRange(url, dataStart, dataStart + entry.compressedSize - 1);
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
