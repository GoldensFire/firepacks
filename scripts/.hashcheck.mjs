import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

function literal(value) {
	if (value === null || value === undefined) return 'NULL';
	if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
	if (typeof value === 'bigint') return String(value);
	if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `X'${Buffer.from(value).toString('hex')}'`;
	return `'${String(value).replace(/'/g, "''")}'`;
}
const digest = text => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);

const db = new DatabaseSync('data/sibase.db', { readOnly: true });
const row = db.prepare('SELECT * FROM packages WHERE id = 12994').get();
const hash = digest(Object.keys(row).map(c => literal(row[c])).join(' '));
const stored = db.prepare("SELECT hash FROM d1_sync WHERE tbl='packages' AND row_id=12994").get();

console.log('отпечаток строки сейчас :', hash);
console.log('отпечаток в d1_sync     :', stored?.hash);
console.log(hash === stored?.hash
  ? '>>> СОВПАДАЮТ — выкладка считает строку уже уехавшей и НЕ отправляет её'
  : '>>> различаются — выкладка отправила бы её');
