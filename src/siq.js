// Разбор content.xml из пака SIGame. Поддерживает формат 4 (atom) и 5 (item).

const ENTITIES = {
	'&amp;': '&',
	'&lt;': '<',
	'&gt;': '>',
	'&quot;': '"',
	'&apos;': "'",
};

function decodeXml(value) {
	return value
		.replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
		.replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(parseInt(code, 10)))
		.replace(/&(amp|lt|gt|quot|apos);/g, m => ENTITIES[m]);
}

function parseAttributes(source) {
	const attributes = {};
	const pattern = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
	let match;

	while ((match = pattern.exec(source)) !== null) {
		attributes[match[1]] = decodeXml(match[2]);
	}

	return attributes;
}

function collectTexts(source, tag) {
	const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
	const result = [];
	let match;

	while ((match = pattern.exec(source)) !== null) {
		const text = decodeXml(match[1]).replace(/<[^>]*>/g, '').trim();

		if (text) {
			result.push(text);
		}
	}

	return result;
}

function countContentTypes(body) {
	const stat = { text: 0, image: 0, audio: 0, video: 0, html: 0 };

	// Формат 5
	let match;
	const itemPattern = /<item\b([^>]*)>/g;

	while ((match = itemPattern.exec(body)) !== null) {
		const type = (parseAttributes(match[1]).type ?? 'text').toLowerCase();

		if (stat[type] !== undefined) {
			stat[type]++;
		} else {
			stat.text++;
		}
	}

	// Формат 4
	const atomPattern = /<atom\b([^>]*)>/g;

	while ((match = atomPattern.exec(body)) !== null) {
		const type = (parseAttributes(match[1]).type ?? 'text').toLowerCase();

		if (type === 'voice') {
			stat.audio++;
		} else if (stat[type] !== undefined) {
			stat[type]++;
		} else {
			stat.text++;
		}
	}

	return stat;
}

/**
 * Виды спецвопросов и то, во что они сводятся. Формат 4 пишет вид отдельным
 * тегом (<type name="cat"/>), формат 5 — атрибутом самого вопроса
 * (<question type="secret">), и называются одни и те же вещи там по-разному:
 * «auction» пятой версии зовётся «stake», а «кот в мешке» — «secret».
 *
 * Всё, чего в списке нет, но что вопрос всё же чем-то помечен, попадает
 * в «прочие особые»: новые виды в формат добавляют, и молча терять их не стоит.
 */
const SPECIAL_TYPES = {
	auction: 'auction',
	stake: 'auction',
	stakeAll: 'auction',
	cat: 'cat',
	bagcat: 'cat',
	secret: 'cat',
	secretPublicPrice: 'cat',
	secretNoQuestion: 'cat',
	sponsored: 'noRisk',
	noRisk: 'noRisk',
	forAll: 'forAll',
};

/**
 * Сколько в паке особых вопросов и каких. Обычный вопрос вида не имеет вовсе
 * или помечен «simple» — такие не считаются.
 *
 * @returns {{total: number, byKind: Object<string, number>}}
 */
function countSpecials(body) {
	const byKind = {};
	let total = 0;

	for (const question of splitByTag(body, 'question')) {
		// Формат 5 держит вид в атрибуте вопроса, формат 4 — во вложенном теге.
		// Тег ищется от начала области, а она кончается на следующем вопросе,
		// так что чужой вид сюда не попадёт.
		const inner = /<type\b([^>]*)\/?>/.exec(question.body);
		const kind = ((question.attributes.type ?? '').trim()
			|| (inner ? (parseAttributes(inner[1]).name ?? '').trim() : ''));

		if (!kind || kind === 'simple') {
			continue;
		}

		const key = SPECIAL_TYPES[kind] ?? 'other';
		byKind[key] = (byKind[key] ?? 0) + 1;
		total++;
	}

	return { total, byKind };
}

/** Разбивает кусок XML на области по открывающему тегу. */
function splitByTag(source, tag) {
	const pattern = new RegExp(`<${tag}\\b([^>]*)>`, 'g');
	const starts = [];
	let match;

	while ((match = pattern.exec(source)) !== null) {
		starts.push({ attributes: parseAttributes(match[1]), start: match.index + match[0].length });
	}

	return starts.map((item, i) => ({
		attributes: item.attributes,
		body: source.slice(item.start, i + 1 < starts.length ? starts[i + 1].start : source.length),
	}));
}

const FILE_NAME = /\.(jpe?g|png|gif|webp|bmp|mp3|wav|ogg|m4a|opus|mp4|webm|mov|avi|mkv)$/i;

/**
 * Имя вложенного файла бывает говорящим («Naruto - Blue Bird.mp3»), а бывает мусором
 * из цифр и хешей. Второе только зашумит выжимку.
 */
function meaningfulFileName(value) {
	const name = value.replace(/^@/, '').replace(FILE_NAME, '').trim();
	const letters = (name.match(/\p{L}/gu) ?? []).length;

	if (letters < 4 || letters / name.length <= 0.5 || name.length > 60) {
		return '';
	}

	// Хеши и идентификаторы ВК: длинная строка без единого пробела
	if (!name.includes(' ') && name.length > 16) {
		return '';
	}

	return name;
}

/**
 * Короткая выжимка темы: ответы плюс тексты вопросов. По ней потом определяется
 * тематика, поэтому важна не полнота, а разнообразие. Ответы вроде «A», «B», «Правда»
 * ничего не говорят, и тогда вес смещается на сами вопросы.
 */
function buildSample(themeBody) {
	const answers = collectTexts(themeBody, 'answer').filter(t => t.length >= 3);

	// Формат 5 держит содержимое в item, формат 4 — в atom
	const questions = [...collectTexts(themeBody, 'item'), ...collectTexts(themeBody, 'atom')]
		.map(text => text.startsWith('@') || FILE_NAME.test(text) ? meaningfulFileName(text) : text)
		.filter(text => text && !/^https?:/i.test(text));

	const seen = [];
	const chosen = [];
	let length = 0;

	// «Вольт (2008)» и файл «Вольт2 (2008).jpg» — одно и то же, второй раз это не нужно.
	// Цифры выбрасываются: они чаще нумеруют файлы, чем различают ответы.
	const simplify = text => text.toLowerCase().replace(/[^\p{L}]+/gu, '');

	const take = (list, max) => {
		let taken = 0;

		for (const part of list) {
			if (taken >= max || length > 460) {
				break;
			}

			const flat = part.replace(/\s+/g, ' ').trim();
			const short = flat.length > 70 ? `${flat.slice(0, 70)}…` : flat;
			const key = simplify(short);

			// Совпадением считаем только длинные куски: «ад» внутри «адмирал» ничего не значит
			if (!key || seen.some(other => (other.includes(key) || key.includes(other)) && Math.min(other.length, key.length) >= 4)) {
				continue;
			}

			seen.push(key);
			chosen.push(short);
			length += short.length + 3;
			taken++;
		}
	};

	take(answers, 8);
	take(questions, 6);

	return chosen.join(' / ').slice(0, 500);
}

/** Преобладающий тип содержимого темы: по нему видно музыкальные и видео-темы. */
function dominantMedia(themeBody) {
	const stat = countContentTypes(themeBody);
	const media = [['audio', stat.audio], ['video', stat.video], ['image', stat.image]];
	const total = stat.text + stat.image + stat.audio + stat.video;
	const [type, count] = media.sort((a, b) => b[1] - a[1])[0];

	return total > 0 && count / total > 0.4 ? type : '';
}

/**
 * Правильные ответы вопроса. Берутся только из <right>: в <wrong> лежат
 * неверные, и складывать их вместе значило бы считать разными два одинаковых
 * вопроса, у одного из которых автор дописал пару неправильных вариантов.
 */
const RIGHT_BLOCK = /<right\b[^>]*>([\s\S]*?)<\/right>/;

/**
 * Содержимое одного вопроса, разобранное на три части: сам вопрос, имена
 * приложенных к нему файлов и правильный ответ.
 *
 * Ради поиска списанного (см. src/plagiarism.js). Тексты вопросов в базе
 * не хранятся — они весят больше всего остального пака вместе взятого, —
 * а хранится восьмибайтный отпечаток вот этих трёх частей: он отвечает
 * на единственный вопрос, который тут задают, «стоял ли ровно этот вопрос
 * в чужом паке раньше».
 *
 * Части разделены нарочно, а не склеены в одну строку прямо здесь: склейку
 * с разделителями делает тот, кто считает отпечаток, и делает одинаково
 * для всех — иначе «вопрос без файла» и «файл без вопроса» с одинаковым
 * ответом сошлись бы в один отпечаток.
 *
 * Имя файла в счёт входит на равных с текстом. У медиавопроса текста нет вовсе
 * («что это за песня?» задаёт сам файл), и без имени файла все такие вопросы
 * одного пака различались бы только ответом. А имя это как раз и переезжает
 * из пака в пак нетронутым: перекладывают папку Audio целиком.
 *
 * Формат 4 держит содержимое в <atom>, формат 5 — в <item>; и там, и там
 * ссылка на файл пишется с собачкой впереди («@Naruto.mp3»).
 */
function questionParts(questionBody, mediaSizes) {
	const pieces = [...collectTexts(questionBody, 'item'), ...collectTexts(questionBody, 'atom')];
	const text = [];
	const media = [];
	let mediaBytes = 0;

	for (const piece of pieces) {
		if (piece.startsWith('@') || FILE_NAME.test(piece)) {
			const name = piece.replace(/^@/, '');
			media.push(name);
			// Вес файла из оглавления архива. Ноль — «в архиве такого файла нет»
			// или «разбирали без архива»: это неизвестность, а не пустота,
			// и толкуется она в пользу совпадения (см. sameWeight в plagiarism.js)
			mediaBytes += mediaSizes?.get(name.split('/').pop().toLowerCase()) ?? 0;
		} else {
			text.push(piece);
		}
	}

	const right = RIGHT_BLOCK.exec(questionBody);

	return {
		text: text.join(' '),
		media: media.join(' '),
		answer: right ? collectTexts(right[1], 'answer').join(' ') : '',
		// Сумма, а не список: вопросу с двумя файлами всё равно нужно одно число,
		// а сумма расходится ровно тогда же, когда разошёлся бы любой из двух
		mediaBytes,
	};
}

/**
 * Все вопросы пака подряд, каждый со своим местом в раундах.
 *
 * Место (номер раунда и номер темы) едет рядом с содержимым потому, что метку
 * «взято отсюда» сайт ставит теме, а не вопросу: мельче темы он ничего
 * не показывает (см. roundsForApi в src/keys.js). Считается плагиат по вопросам,
 * а показывается по темам — и связывает одно с другим как раз это место.
 */
function collectQuestions(body, mediaSizes) {
	const questions = [];

	splitByTag(body, 'round').forEach((round, roundIndex) => {
		// Номер темы считается своим счётчиком, а не местом в разборе: тему
		// без названия parseRounds выбрасывает, и порядковый номер после неё
		// съезжает. Разойдись эти два счёта — и метка «взято отсюда» встала бы
		// не на ту тему
		let themeIndex = 0;

		for (const theme of splitByTag(round.body, 'theme')) {
			if (!theme.attributes.name) {
				continue;
			}

			for (const question of splitByTag(theme.body, 'question')) {
				questions.push({ round: roundIndex, theme: themeIndex, ...questionParts(question.body, mediaSizes) });
			}

			themeIndex++;
		}
	});

	return questions;
}

function parseRounds(body) {
	const rounds = [];
	const regions = splitByTag(body, 'round');

	for (let i = 0; i < regions.length; i++) {
		const themes = [];

		for (const theme of splitByTag(regions[i].body, 'theme')) {
			const name = theme.attributes.name;

			if (!name) {
				continue;
			}

			themes.push({
				name,
				questions: (theme.body.match(/<question[\s>]/g) ?? []).length,
				media: dominantMedia(theme.body),
				sample: buildSample(theme.body),
			});
		}

		rounds.push({
			name: regions[i].attributes.name ?? `Раунд ${i + 1}`,
			type: regions[i].attributes.type ?? '',
			themes,
		});
	}

	return rounds;
}

/**
 * Разбирает content.xml.
 *
 * @param {Buffer} buffer содержимое content.xml
 * @param {Map<string, number>} [mediaSizes] вес вложенных файлов по имени
 *        без папки (см. mediaSizes в src/zip.js). Нужен только отпечаткам
 *        вопросов: по весу отменяется совпадение, у которого сошлись имя файла
 *        и ответ, а сам файл разный. Без него разбор считает как раньше —
 *        вес у всех вопросов выходит нулевым, то есть неизвестным.
 */
export function parseContentXml(buffer, mediaSizes = null) {
	// SIQ пишется в UTF-8, но с BOM
	let xml = buffer.toString('utf8');

	if (xml.charCodeAt(0) === 0xfeff) {
		xml = xml.slice(1);
	}

	const packageMatch = /<package\b([^>]*)>/.exec(xml);

	if (!packageMatch) {
		throw new Error('в content.xml нет элемента package');
	}

	const attributes = parseAttributes(packageMatch[1]);
	const roundsStart = xml.indexOf('<rounds');
	const header = roundsStart > 0 ? xml.slice(0, roundsStart) : xml;
	const body = roundsStart > 0 ? xml.slice(roundsStart) : '';

	const rounds = parseRounds(body);
	const questionCount = (body.match(/<question[\s>]/g) ?? []).length;
	const specials = countSpecials(body);
	const difficulty = parseInt(attributes.difficulty ?? '', 10);

	return {
		name: (attributes.name ?? '').trim(),
		id: attributes.id ?? null,
		version: attributes.version ?? null,
		date: attributes.date ?? null,
		language: attributes.language ?? null,
		// Логотип лежит в архиве как Images/<имя>, обычно в percent-кодировке
		logo: attributes.logo ? attributes.logo.replace(/^@/, '') : null,
		authorDifficulty: Number.isFinite(difficulty) ? difficulty : null,
		authors: collectTexts(header, 'author'),
		tags: collectTexts(header, 'tag'),
		rounds,
		roundCount: rounds.length,
		themeCount: rounds.reduce((sum, round) => sum + round.themes.length, 0),
		questionCount,
		// Аукционы, коты в мешке и вопросы без риска: их считают отдельно, потому
		// что пак с двумя десятками котов играется совсем не так, как обычный
		specialCount: specials.total,
		specialStat: specials.byKind,
		contentStat: countContentTypes(body),
		// Содержимое вопросов — единственное, что отсюда не попадает в саму базу:
		// из него считается восьмибайтный отпечаток на вопрос, и хранится он
		// (см. encodePrints в src/plagiarism.js и таблицу pack_prints в src/db.js)
		questions: collectQuestions(body, mediaSizes),
	};
}
