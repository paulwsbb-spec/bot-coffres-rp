// Exporte la base SQLite du PC (data/coffres.db) en SQL pour la base D1 de Cloudflare.
//   node cloud/scripts/export-local.mjs > cloud/generated/data.sql
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const db = new DatabaseSync(path.join(root, 'data', 'coffres.db'), { readOnly: true });
const q = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const dump = (table, cols, rows) => rows.forEach((r) =>
  console.log(`INSERT OR IGNORE INTO ${table} (${cols.join(',')}) VALUES (${cols.map((c) => q(r[c])).join(',')});`));

dump('transactions', ['message_id', 'idx', 'channel_id', 'ts', 'coffre', 'player', 'player_id', 'action', 'kind', 'item', 'quantity', 'amount', 'raw'],
  db.prepare('SELECT * FROM transactions ORDER BY ts, id').all());
dump('unparsed', ['message_id', 'channel_id', 'ts', 'raw'], db.prepare('SELECT * FROM unparsed').all());
dump('anchors', ['coffre', 'item', 'amount', 'ts'], db.prepare('SELECT * FROM anchors').all());
dump('cursors', ['channel_id', 'newest_id'], db.prepare('SELECT channel_id, newest_id FROM cursors').all());
dump('panels', ['coffre', 'channel_id', 'message_id'], db.prepare('SELECT * FROM panels').all());
