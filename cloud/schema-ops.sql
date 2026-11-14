-- Module opérations : braquages Fleeca / armurerie + transactions (ventes / achats) et taxes
CREATE TABLE IF NOT EXISTS ops (
  id           INTEGER PRIMARY KEY,
  type         TEXT NOT NULL,            -- 'fleeca' | 'armurerie'
  success      INTEGER NOT NULL,         -- 1 réussi, 0 échec
  participants TEXT,
  loot         REAL,
  ts           INTEGER NOT NULL,         -- date de l'opération (ms)
  notes        TEXT,
  author_id    TEXT,
  author       TEXT,
  next_at      INTEGER NOT NULL,         -- fin du cooldown (ms)
  reminded     INTEGER NOT NULL DEFAULT 0,
  message_id   TEXT
);
CREATE INDEX IF NOT EXISTS ops_type_ts ON ops (type, ts);
CREATE INDEX IF NOT EXISTS ops_remind ON ops (reminded, next_at);

CREATE TABLE IF NOT EXISTS transacs (
  id         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL,              -- 'vente' | 'achat'
  amount     REAL NOT NULL,
  object     TEXT,
  partner    TEXT,
  tax        REAL NOT NULL DEFAULT 0,
  ts         INTEGER NOT NULL,
  author_id  TEXT,
  author     TEXT
);
CREATE INDEX IF NOT EXISTS transacs_ts ON transacs (ts);
