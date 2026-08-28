// Один автор — один человек: сводит подписи, за которыми стоит один и тот же
// человек, к одному автору.
//
// Ни сети, ни модели — одна выборка по базе. Без неё топ авторов разваливает
// человека на столько строк, сколько ников он себе придумал.

import { db } from '../db.js';
import { say } from './progress.js';

// ————— один автор — один человек —————

/**
 * Сводит подписи, за которыми стоит один и тот же человек, к одному автору.
 *
 * ————— чем плоха подпись в файле —————
 *
 * Автор пака — это то, что написано в поле <author> внутри .siq, и написано там
 * что угодно. Один и тот же человек подписывается то ником, то ником с цифрой,
 * то названием своей команды, то именем и фамилией; в топе авторов он стоял
 * столькими строками, сколько написаний придумал, и в каждой — своя горстка
 * паков вместо общего счёта.
 *
 * Между тем видно, что это один человек: паки выложены с одной и той же
 * страницы ВК. Имя в ВК меняют, адрес страницы — нет, и другого столь же
 * твёрдого признака у нас нет (по нему же считается «свой пак» в плагиате,
 * см. samePerson в src/plagiarism.js).
 *
 * ————— почему не «все подписи одного аккаунта — один человек» —————
 *
 * Потому что с одного аккаунта выкладывают и чужое. Человек, перевыложивший
 * пак приятеля, забрал бы себе и приятеля со всеми его паками — а тот выкладывал
 * их сам и со своей страницы.
 *
 * Поэтому сливаются только подписи, за которыми никого другого не стоит:
 * подпись переходит к аккаунту, если ВСЕ её паки выложены с него одного.
 * Подпись, встретившаяся у двух аккаунтов, остаётся сама по себе — это ровно
 * тот случай, когда неизвестно, кто из них автор, и выдумывать нечего.
 *
 * Главным именем становится то написание, которым подписано больше паков:
 * это то имя, под которым человека знают. При равенстве — то, что короче
 * и раньше по алфавиту, чтобы выбор не плясал от запуска к запуску.
 */
export function mergeAuthors() {
	// Строка на «подпись под паком, выложенным с этого аккаунта». Мёртвые
	// и похороненные паки в счёт идут наравне с живыми: аккаунт, с которого
	// выкладывали, остаётся тем же аккаунтом, а вот подпись, встречающаяся
	// только у мёртвого пака, без них потеряла бы своего человека
	const rows = db.prepare(`
		SELECT a.author_key AS key, a.author AS name, p.vk_author_url AS account, COUNT(*) AS packs
		FROM pack_authors a JOIN packages p ON p.id = a.package_id
		GROUP BY a.author_key, a.author, p.vk_author_url
	`).all();

	/** Подпись -> {написания, аккаунты, сколько паков}. */
	const signatures = new Map();

	for (const row of rows) {
		let item = signatures.get(row.key);

		if (!item) {
			item = { key: row.key, spellings: new Map(), accounts: new Set(), packs: 0 };
			signatures.set(row.key, item);
		}

		item.spellings.set(row.name, (item.spellings.get(row.name) ?? 0) + row.packs);
		item.packs += row.packs;

		const account = (row.account ?? '').trim();

		// Пак, выложенный не через ВК или без адреса автора, аккаунтом
		// не считается: неизвестность не должна связывать подписи между собой
		if (account) {
			item.accounts.add(account);
		} else {
			item.accounts.add(`?${row.key}`);
		}
	}

	/** Аккаунт -> подписи, которые нигде больше не встречаются. */
	const byAccount = new Map();

	for (const item of signatures.values()) {
		if (item.accounts.size !== 1) {
			continue;
		}

		const account = [...item.accounts][0];

		// Мнимый аккаунт «?подпись» — это «выложено без адреса»: собственный
		// у каждой подписи, и слить он ничего не может
		if (account.startsWith('?')) {
			continue;
		}

		const known = byAccount.get(account) ?? [];
		known.push(item);
		byAccount.set(account, known);
	}

	const write = db.prepare('UPDATE pack_authors SET canon_key = ?, canon_name = ? WHERE author_key = ?');
	const reset = db.prepare('UPDATE pack_authors SET canon_key = author_key, canon_name = author WHERE canon_key <> author_key');

	// Сначала всё возвращается к подписям, потом сливается заново. Иначе слияние,
	// отменённое новыми паками (подпись встретилась у второго аккаунта), осталось
	// бы в базе навсегда
	reset.run();

	let merged = 0;
	let people = 0;

	for (const group of byAccount.values()) {
		if (group.length < 2) {
			continue;
		}

		// Главное написание — то, которым подписано больше паков
		const best = group
			.flatMap(item => [...item.spellings.entries()].map(([name, packs]) => ({ name, packs })))
			.sort((a, b) => b.packs - a.packs || a.name.length - b.name.length || a.name.localeCompare(b.name))[0];

		const canonKey = group
			.slice()
			.sort((a, b) => b.packs - a.packs || a.key.length - b.key.length || a.key.localeCompare(b.key))[0].key;

		for (const item of group) {
			write.run(canonKey, best.name, item.key);
		}

		people++;
		merged += group.length - 1;

		say('authors', `${best.name}: ${group.map(item => item.key).join(', ')}`);
	}

	say('authors', `подписей ${signatures.size}; сведено ${merged} лишних к ${people} авторам `
		+ '(паки выложены с одной страницы ВК)');
}
