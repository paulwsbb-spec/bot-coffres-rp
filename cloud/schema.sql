CREATE TABLE IF NOT EXISTS transactions (
  id          INTEGER PRIMARY KEY,
  message_id  TEXT NOT NULL,
  idx         INTEGER NOT NULL DEFAULT 0,
  channel_id  TEXT,
  ts          INTEGER NOT NULL,
  coffre      TEXT NOT NULL,
  player      TEXT,
  player_id   TEXT,
  action      TEXT NOT NULL,
  kind        TEXT NOT NULL,
  item        TEXT NOT NULL,
  quantity    REAL NOT NULL DEFAULT 0,
  amount      REAL,
  raw         TEXT,
  UNIQUE (message_id, idx)
);
CREATE INDEX IF NOT EXISTS tx_ts     ON transactions (ts);
CREATE INDEX IF NOT EXISTS tx_coffre ON transactions (coffre, ts);
CREATE INDEX IF NOT EXISTS tx_player ON transactions (player COLLATE NOCASE, ts);
CREATE INDEX IF NOT EXISTS tx_item   ON transactions (item COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS unparsed (message_id TEXT PRIMARY KEY, channel_id TEXT, ts INTEGER, raw TEXT);
CREATE TABLE IF NOT EXISTS anchors (coffre TEXT NOT NULL, item TEXT NOT NULL, amount REAL NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (coffre, item));
CREATE TABLE IF NOT EXISTS cursors (channel_id TEXT PRIMARY KEY, newest_id TEXT);
CREATE TABLE IF NOT EXISTS panels (coffre TEXT PRIMARY KEY, channel_id TEXT, message_id TEXT);
