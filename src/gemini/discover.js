// Что нового у ключа: раз в сутки спросить Gemini, какие модели ему доступны,
// и вписать в список те, из которых уже всё известно.
//
// Отдельным файлом, а не строкой в models.js, по одной причине: спрашивать
// приходится у api.js, а api.js спрашивает у models.js, какая модель выбрана
// и сколько ей осталось. Положи находку в models.js — и два файла стали бы
// знать друг о друге, то есть граница между «что мы знаем про модели»
// и «как мы с ними разговариваем» пропала бы вовсе.
//
// Список моделей запросом к модели не считается: ListModels — это метаданные,
// суточная квота их не замечает (см. noteRequest в src/models.js — он зовётся
// только на generateContent). Поэтому спрашивать можно смело, и всё же
// спрашивается раз в сутки: обход запускается по десять раз за ночь,
// а новые модели выходят не десять раз за ночь.

import { getSetting, setSetting } from '../db.js';
import { isNewerModel, quotaDay, registerModel, rememberDiscovered, usage } from '../models.js';
import { hasGemini, listModels } from './api.js';

const ASKED_KEY = 'gemini_models_asked';

/**
 * Спрашивает у ключа список моделей и добавляет незнакомые разметчики в список.
 *
 * Правило отбора нарочно узкое (см. FAMILY_ID и isNewerModel в src/models.js):
 * название вида «gemini-<версия>-flash» или то же с «-lite», и номер версии
 * выше, чем у всех уже известных того же семейства. Ключу видны четыре десятка
 * названий — рисовалки картинок, озвучка, робототехника, deep research, —
 * и ни одно из них размечать паки не годится. Предварительные сборки
 * («-preview») тоже мимо: они закрываются без предупреждения, и вписывать
 * такую самим значило бы однажды ночью остаться без разметки вовсе.
 *
 * Про номер версии стоит сказать отдельно, потому что без него правило
 * не работает вовсе: у ключа лежат «gemini-2.5-flash» и «gemini-2.5-flash-lite»
 * с безупречными названиями и отказом «no longer available to new users»
 * на первом же запросе. Отличить их от живых можно только по номеру.
 *
 * Уже помеченные как закрытые для ключа (см. noteUnavailable) пропускаются:
 * иначе всякая находка, отказавшая один раз, возвращалась бы в список каждые
 * сутки.
 *
 * @param {boolean} force спросить, не дожидаясь суток
 * @returns {Promise<string[]>} что нашлось нового
 */
export async function discoverModels({ force = false } = {}) {
	if (!hasGemini()) {
		return [];
	}

	const today = quotaDay();

	if (!force && getSetting(ASKED_KEY) === today) {
		return [];
	}

	let available;

	try {
		available = await listModels();
	} catch {
		// Не вышло спросить — не беда и не повод останавливать обход: список
		// в models.js работает сам по себе, а спросим завтра.
		return [];
	}

	setSetting(ASKED_KEY, today);

	const found = [];

	for (const { name } of available) {
		if (!isNewerModel(name) || usage(name).unavailable) {
			continue;
		}

		if (registerModel(name)) {
			found.push(name);
		}
	}

	if (found.length > 0) {
		rememberDiscovered();
	}

	return found;
}
