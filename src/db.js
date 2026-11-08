import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

export const bus = new EventEmitter();
bus.setMaxListeners(100);

export function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS transactions (
      id          INTEGER PRIMARY KEY,
      message_id  TEXT NOT NULL,
      idx         INTEGER NOT NULL DEFAULT 0,
      channel_id  TEXT,
      ts          INTEGER NOT NULL,          -- ms epoch
      coffre      TEXT NOT NULL,
      player      TEXT,
      player_id   TEXT,
      action      TEXT NOT NULL CHECK (action IN ('deposit','withdraw')),
      kind        TEXT NOT NULL CHECK (kind IN ('money','item')),
      item        TEXT NOT NULL,
      quantity    REAL NOT NULL DEFAULT 0,
      amount      REAL,                       -- montant si kind = money
      raw         TEXT,
      UNIQUE (message_id, idx)
    );
    CREATE INDEX IF NOT EXISTS tx_ts      ON transactions (ts);
    CREATE INDEX IF NOT EXISTS tx_coffre  ON transactions (coffre, ts);
    CREATE INDEX IF NOT EXISTS tx_player  ON transactions (player COLLATE NOCASE, ts);
    CREATE INDEX IF NOT EXISTS tx_item    ON transactions (item COLLATE NOCASE);

    CREATE TABLE IF NOT EXISTS unparsed (
      message_id TEXT PRIMARY KEY,
      channel_id TEXT,
      ts         INTEGER,
      raw        TEXT
    );

    CREATE TABLE IF NOT EXISTS cursors (
      channel_id    TEXT PRIMARY KEY,
      oldest_id     TEXT,
      newest_id     TEXT,
      backfill_done INTEGER NOT NULL DEFAULT 0,
      scanned       INTEGER NOT NULL DEFAULT 0
    );
  `);
  return db;
}

export function snowflakeGt(a, b) {
  if (!b) return true;
  if (!a) return false;
  return BigInt(a) > BigInt(b);
}

/**
 * Enregistre un message : ses transactions, ou dans `unparsed` s'il n'a rien donné.
 * Idempotent (message_id + idx unique) => on peut ré-importer sans doublons.
 * Retourne les transactions réellement ajoutées.
 */
export function makeIngestor(db, parse) {
  const insTx = db.prepare(`INSERT OR IGNORE INTO transactions
    (message_id, idx, channel_id, ts, coffre, player, player_id, action, kind, item, quantity, amount, raw)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insUnparsed = db.prepare(`INSERT OR IGNORE INTO unparsed (message_id, channel_id, ts, raw) VALUES (?,?,?,?)`);
  const delUnparsed = db.prepare(`DELETE FROM unparsed WHERE message_id = ?`);

  return function ingest(msg, { defaultCoffre = null, emit = true } = {}) {
    const txs = parse(msg, { defaultCoffre });
    const raw = JSON.stringify({ content: msg.content || undefined, embeds: msg.embeds?.length ? msg.embeds : undefined });
    if (!txs.length) {
      insUnparsed.run(msg.id, msg.channelId ?? null, msg.ts, raw);
      return [];
    }
    delUnparsed.run(msg.id);
    const added = [];
    txs.forEach((t, i) => {
      const r = insTx.run(msg.id, i, msg.channelId ?? null, msg.ts, t.coffre, t.player, t.player_id,
        t.action, t.kind, t.item, t.quantity, t.amount, i === 0 ? raw : null);
      if (r.changes) added.push({ ...t, id: Number(r.lastInsertRowid), message_id: msg.id, channel_id: msg.channelId ?? null, ts: msg.ts });
    });
    if (emit && added.length) bus.emit('tx', added);
    return added;
  };
}

/**
 * Ré-analyse tous les logs déjà stockés avec le parseur actuel (après modification des règles).
 * Les messages bruts sont conservés en base, donc pas besoin de retélécharger Discord.
 */
export function reparseAll(db, ingest, defaultCoffreFor = () => null) {
  const msgs = db.prepare(`
    SELECT message_id, channel_id, ts, raw FROM transactions WHERE idx = 0 AND raw IS NOT NULL
    UNION ALL SELECT message_id, channel_id, ts, raw FROM unparsed`).all();
  return inTransaction(db, () => {
    db.exec('DELETE FROM transactions; DELETE FROM unparsed;');
    let tx = 0;
    for (const m of msgs) {
      const body = JSON.parse(m.raw || '{}');
      tx += ingest({ id: m.message_id, channelId: m.channel_id, ts: m.ts, content: body.content || '', embeds: body.embeds || [] },
        { defaultCoffre: defaultCoffreFor(m.channel_id), emit: false }).length;
    }
    const unparsed = db.prepare('SELECT COUNT(*) AS n FROM unparsed').get().n;
    return { messages: msgs.length, transactions: tx, unparsed };
  });
}

export function inTransaction(db, fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
