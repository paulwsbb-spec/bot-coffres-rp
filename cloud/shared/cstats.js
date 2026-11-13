// Statistiques — version Cloudflare (D1, asynchrone, heure de Paris).
// Même logique que src/stats.js (version PC), adaptée aux limites des Workers.

export const TZ = 'Europe/Paris';

const MONEY_SUMS = `
  COALESCE(SUM(CASE WHEN kind='money' AND item='cash'        AND action='deposit'  THEN amount END),0) AS cash_in,
  COALESCE(SUM(CASE WHEN kind='money' AND item='cash'        AND action='withdraw' THEN amount END),0) AS cash_out,
  COALESCE(SUM(CASE WHEN kind='money' AND item='black_money' AND action='deposit'  THEN amount END),0) AS black_in,
  COALESCE(SUM(CASE WHEN kind='money' AND item='black_money' AND action='withdraw' THEN amount END),0) AS black_out,
  COALESCE(SUM(CASE WHEN kind='item' AND action='deposit'  THEN quantity END),0) AS items_in,
  COALESCE(SUM(CASE WHEN kind='item' AND action='withdraw' THEN quantity END),0) AS items_out`;

/** Décalage horaire de Paris (en minutes) à l'instant ts : +60 l'hiver, +120 l'été */
export function tzOffset(ts = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'shortOffset' }).formatToParts(new Date(ts));
  const m = /GMT([+-]\d+)(?::(\d+))?/.exec(parts.find((p) => p.type === 'timeZoneName')?.value || '');
  return m ? Number(m[1]) * 60 + Math.sign(Number(m[1])) * Number(m[2] || 0) : 0;
}
const sqlTz = (ts = Date.now()) => `${tzOffset(ts) >= 0 ? '+' : ''}${tzOffset(ts)} minutes`;

/** Début de la semaine de classement contenant ts : dimanche 19h (heure de Paris) */
export function weekStart(ts = Date.now()) {
  const off = tzOffset(ts) * 60e3;
  const d = new Date(ts + off); // "heure de Paris" lue en UTC
  let s = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - d.getUTCDay(), 19, 0, 0);
  s -= tzOffset(s - off) * 60e3;
  if (s > ts) return weekStart(s - 3600e3 * 24 * 6.5);
  return s;
}
export function weekEnd(start) { return weekStart(start + 8 * 86400e3); }

export function buildWhere(f = {}, extra = []) {
  const c = [...extra];
  const p = [];
  if (f.coffre) { c.push('coffre = ?'); p.push(f.coffre); }
  if (f.player) { c.push('player = ? COLLATE NOCASE'); p.push(f.player); }
  if (f.item) { c.push('item = ? COLLATE NOCASE'); p.push(f.item); }
  if (f.action) { c.push('action = ?'); p.push(f.action); }
  if (f.kind) { c.push('kind = ?'); p.push(f.kind); }
  if (f.from) { c.push('ts >= ?'); p.push(Number(f.from)); }
  if (f.to) { c.push('ts <= ?'); p.push(Number(f.to)); }
  if (f.q) {
    c.push('(player LIKE ? OR item LIKE ? OR coffre LIKE ? OR player_id LIKE ?)');
    const like = `%${f.q}%`;
    p.push(like, like, like, like);
  }
  return { sql: c.length ? `WHERE ${c.join(' AND ')}` : '', params: p };
}

export function periodToRange(period) {
  const m = /^(\d+)\s*(h|d|j|w|m)$/i.exec(String(period || ''));
  if (!m) return {};
  const unit = { h: 3600e3, d: 86400e3, j: 86400e3, w: 7 * 86400e3, m: 30 * 86400e3 }[m[2].toLowerCase()];
  return { from: Date.now() - Number(m[1]) * unit };
}

export function createStats(DB) {
  const all = async (sql, params = []) => (await DB.prepare(sql).bind(...params).all()).results || [];
  const get = async (sql, params = []) => (await DB.prepare(sql).bind(...params).first()) || {};

  /**
   * Argent dans chaque coffre, mouvement par mouvement dans l'ordre chronologique :
   *  • départ = solde saisi avec /solde (sinon 0)
   *  • un dépôt ajoute, un retrait enlève
   *  • jamais en dessous de 0 : si on retire plus que ce que le bot connaît (argent mis avant le webhook,
   *    coffre déplacé…), le coffre tombe à 0 au lieu d'un solde négatif.
   */
  async function balances() {
    const [anchors, rows] = await Promise.all([
      all('SELECT coffre, item, amount, ts FROM anchors'),
      all(`SELECT coffre, item, action, amount, ts FROM transactions WHERE kind = 'money' ORDER BY ts, id`),
    ]);
    const anchor = Object.fromEntries(anchors.map((a) => [`${a.coffre}|${a.item}`, a]));
    const cur = {};
    for (const a of anchors) cur[`${a.coffre}|${a.item}`] = a.amount;
    for (const r of rows) {
      const k = `${r.coffre}|${r.item}`;
      if (anchor[k] && r.ts <= anchor[k].ts) continue;
      cur[k] = Math.max(0, (cur[k] || 0) + (r.action === 'deposit' ? r.amount : -r.amount));
    }
    const map = {};
    for (const [k, v] of Object.entries(cur)) {
      const [coffre, item] = k.split('|');
      const s = (map[coffre] ||= { cash: 0, black: 0, anchored_at: null });
      s[item === 'cash' ? 'cash' : 'black'] += v;
      if (anchor[k]) s.anchored_at = Math.max(s.anchored_at || 0, anchor[k].ts);
    }
    for (const s of Object.values(map)) s.total = s.cash + s.black;
    return map;
  }
  async function balance(coffre = null) {
    const map = await balances();
    const list = coffre ? [map[coffre] || { cash: 0, black: 0, anchored_at: null }] : Object.values(map);
    const out = { cash: 0, black: 0, anchored_at: null };
    for (const s of list) { out.cash += s.cash; out.black += s.black; if (s.anchored_at) out.anchored_at = Math.max(out.anchored_at || 0, s.anchored_at); }
    out.total = out.cash + out.black;
    return out;
  }

  async function players(f, { sort = 'activity', limit = 50 } = {}) {
    const order = {
      activity: 'n DESC', deposit: '(cash_in + black_in) DESC', withdraw: '(cash_out + black_out) DESC',
      net: '(cash_in + black_in - cash_out - black_out) ASC', items_out: 'items_out DESC',
    }[sort] || 'n DESC';
    const w = buildWhere(f, ['player IS NOT NULL']);
    return all(`SELECT player, MAX(player_id) AS player_id, COUNT(*) AS n, MAX(ts) AS last_ts,
                COUNT(DISTINCT coffre) AS coffres, ${MONEY_SUMS}
                FROM transactions ${w.sql} GROUP BY player COLLATE NOCASE ORDER BY ${order} LIMIT ?`,
    [...w.params, Number(limit)]);
  }

  async function items(f, { limit = 100 } = {}) {
    const w = buildWhere(f, ["kind = 'item'"]);
    return (await all(`SELECT item,
                COALESCE(SUM(CASE WHEN action='deposit'  THEN quantity END),0) AS qty_in,
                COALESCE(SUM(CASE WHEN action='withdraw' THEN quantity END),0) AS qty_out,
                COUNT(*) AS n, COUNT(DISTINCT player) AS players, MAX(ts) AS last_ts
                FROM transactions ${w.sql} GROUP BY item COLLATE NOCASE
                ORDER BY (qty_in + qty_out) DESC LIMIT ?`, [...w.params, Number(limit)]))
      .map((r) => ({ ...r, net: r.qty_in - r.qty_out }));
  }

  return {
    balance,

    async setAnchor(coffre, item, amount, ts = Date.now()) {
      await DB.prepare(`INSERT INTO anchors (coffre, item, amount, ts) VALUES (?,?,?,?)
        ON CONFLICT(coffre, item) DO UPDATE SET amount = excluded.amount, ts = excluded.ts`).bind(coffre, item, amount, ts).run();
    },

    async coffres() {
      const [rows, map] = await Promise.all([
        all(`SELECT coffre, COUNT(*) AS n, MAX(ts) AS last_ts, ${MONEY_SUMS} FROM transactions GROUP BY coffre ORDER BY n DESC`),
        balances(),
      ]);
      return rows.map((c) => ({ ...c, balance: map[c.coffre] || { cash: 0, black: 0, total: 0, anchored_at: null } }));
    },

    async summary(f) {
      const w = buildWhere(f);
      const wb = buildWhere({ ...f, from: null });
      const [s, bal, b, u] = await Promise.all([
        get(`SELECT COUNT(*) AS n, COUNT(DISTINCT player) AS players, COUNT(DISTINCT coffre) AS coffres,
             MIN(ts) AS first_ts, MAX(ts) AS last_ts, ${MONEY_SUMS} FROM transactions ${w.sql}`, w.params),
        balance(f.coffre || null),
        get(`SELECT ${MONEY_SUMS} FROM transactions ${wb.sql}`, wb.params),
        get('SELECT COUNT(*) AS n FROM unparsed'),
      ]);
      return { ...s, cash_balance: bal.cash, black_balance: bal.black, anchored_at: bal.anchored_at,
        items_balance: b.items_in - b.items_out, unparsed: u.n || 0 };
    },

    async timeline(f) {
      const first = f.from || (await get('SELECT MIN(ts) AS t FROM transactions')).t || Date.now();
      const span = (f.to || Date.now()) - first;
      const hourly = span <= 3 * 86400e3;
      const w = buildWhere(f);
      return {
        bucket: hourly ? 'hour' : 'day',
        rows: await all(`SELECT strftime('${hourly ? '%Y-%m-%d %H:00' : '%Y-%m-%d'}', ts/1000, 'unixepoch', ?) AS t, COUNT(*) AS n, ${MONEY_SUMS}
                         FROM transactions ${w.sql} GROUP BY t ORDER BY t`, [sqlTz(), ...w.params]),
      };
    },

    players,

    /** Semaines de classement : une seule requête (bornes calculées à l'heure de Paris) */
    async weeks(f = {}) {
      const first = (await get('SELECT MIN(ts) AS t FROM transactions')).t;
      if (!first) return [];
      const starts = [];
      for (let s = weekStart(); s >= weekStart(first) && starts.length < 60; s = weekStart(s - 86400e3)) starts.push(s);
      const bucket = `CASE ${starts.map((s) => `WHEN ts >= ${s} THEN ${s}`).join(' ')} ELSE 0 END`;
      const w = buildWhere(f, ['player IS NOT NULL', `ts >= ${starts.at(-1)}`]);
      const rows = await all(`SELECT ${bucket} AS wk, player,
          COALESCE(SUM(CASE WHEN kind='money' AND action='deposit' THEN amount END),0) AS dep
        FROM transactions ${w.sql} GROUP BY wk, player COLLATE NOCASE`, w.params);
      return starts.map((s, k) => {
        const r = rows.filter((x) => x.wk === s);
        const top = r.reduce((b, x) => (x.dep > (b?.dep || 0) ? x : b), null);
        return { start: s, end: weekEnd(s), current: k === 0, deposited: r.reduce((t, x) => t + x.dep, 0),
          top: top ? { player: top.player, deposited: top.dep } : null };
      });
    },

    async ranking(start = weekStart(), f = {}, limit = 50) {
      return (await players({ ...f, from: start, to: weekEnd(start) - 1 }, { sort: 'deposit', limit }))
        .map((p, k) => ({ rank: k + 1, ...p, deposited: p.cash_in + p.black_in, withdrawn: p.cash_out + p.black_out }));
    },

    async weekReport(start = weekStart(), f = {}, keyItems = []) {
      const end = weekEnd(start);
      const w = buildWhere({ ...f, from: start, to: end - 1 }, ['player IS NOT NULL']);
      const cols = keyItems.map((_, k) => `
        COALESCE(SUM(CASE WHEN kind='item' AND item = ? COLLATE NOCASE AND action='deposit'  THEN quantity END),0) AS i${k}_in,
        COALESCE(SUM(CASE WHEN kind='item' AND item = ? COLLATE NOCASE AND action='withdraw' THEN quantity END),0) AS i${k}_out`).join(',');
      const rows = await all(`SELECT player, COUNT(*) AS n, ${MONEY_SUMS}${cols ? `,${cols}` : ''}
                              FROM transactions ${w.sql} GROUP BY player COLLATE NOCASE`,
      [...keyItems.flatMap((it) => [it, it]), ...w.params]);
      const list = rows.map((r) => ({
        player: r.player, n: r.n, deposited: r.cash_in + r.black_in, withdrawn: r.cash_out + r.black_out,
        items_in: r.items_in, items_out: r.items_out,
        keys: keyItems.map((it, k) => ({ item: it, in: r[`i${k}_in`], out: r[`i${k}_out`] })),
      })).sort((a, b) => b.deposited - a.deposited || b.n - a.n);
      const sum = (fn) => list.reduce((s, p) => s + fn(p), 0);
      return {
        start, end, current: start === weekStart(),
        totals: { deposited: sum((p) => p.deposited), withdrawn: sum((p) => p.withdrawn), n: sum((p) => p.n),
          keys: keyItems.map((it, k) => ({ item: it, in: sum((p) => p.keys[k].in), out: sum((p) => p.keys[k].out) })) },
        players: list,
      };
    },

    async itemDetail(f, item) {
      const g = { ...f, item, kind: 'item' };
      const w = buildWhere(g);
      const ws = buildWhere({ ...g, from: null, to: null });
      const wp = buildWhere(g, ['player IS NOT NULL']);
      const [t, s, pl] = await Promise.all([
        get(`SELECT COALESCE(SUM(CASE WHEN action='deposit' THEN quantity END),0) AS qty_in,
                    COALESCE(SUM(CASE WHEN action='withdraw' THEN quantity END),0) AS qty_out FROM transactions ${w.sql}`, w.params),
        get(`SELECT COALESCE(SUM(CASE WHEN action='deposit' THEN quantity ELSE -quantity END),0) AS stock FROM transactions ${ws.sql}`, ws.params),
        all(`SELECT player, COALESCE(SUM(CASE WHEN action='deposit' THEN quantity END),0) AS qty_in,
                    COALESCE(SUM(CASE WHEN action='withdraw' THEN quantity END),0) AS qty_out
             FROM transactions ${wp.sql} GROUP BY player COLLATE NOCASE ORDER BY (qty_in + qty_out) DESC LIMIT 8`, wp.params),
      ]);
      return { item, ...t, stock: s.stock || 0, players: pl };
    },

    items,
    async stock(f) { return (await items({ ...f, from: null }, { limit: 500 })).sort((a, b) => b.net - a.net); },

    async heatmap(f) {
      const w = buildWhere(f);
      const tz = sqlTz();
      return all(`SELECT CAST(strftime('%w', ts/1000, 'unixepoch', ?) AS INTEGER) AS dow,
                         CAST(strftime('%H', ts/1000, 'unixepoch', ?) AS INTEGER) AS hour, COUNT(*) AS n
                  FROM transactions ${w.sql} GROUP BY dow, hour`, [tz, tz, ...w.params]);
    },

    async transactions(f, { limit = 50, offset = 0 } = {}) {
      const w = buildWhere(f);
      const [t, rows] = await Promise.all([
        get(`SELECT COUNT(*) AS n FROM transactions ${w.sql}`, w.params),
        all(`SELECT id, ts, coffre, player, player_id, action, kind, item, quantity, amount, message_id
             FROM transactions ${w.sql} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`,
        [...w.params, Math.min(Number(limit), 500), Number(offset)]),
      ]);
      return { total: t.n || 0, rows };
    },

    async alerts(f, cfg) {
      const t = cfg.alerts || {};
      const w = buildWhere(f, [`action = 'withdraw'`,
        `((kind='money' AND amount >= ${Number(t.moneyWithdrawThreshold) || 1e12}) OR (kind='item' AND quantity >= ${Number(t.itemWithdrawThreshold) || 1e12}))`]);
      const [bigWithdrawals, pl] = await Promise.all([
        all(`SELECT id, ts, coffre, player, kind, item, quantity, amount FROM transactions ${w.sql} ORDER BY ts DESC LIMIT 30`, w.params),
        players(f, { sort: 'net', limit: 200 }),
      ]);
      const takers = pl
        .map((p) => ({ ...p, money_net: p.cash_in + p.black_in - p.cash_out - p.black_out, item_net: p.items_in - p.items_out }))
        .filter((p) => p.money_net < 0 || p.item_net < -Number(t.itemWithdrawThreshold || 50))
        .map((p) => ({ ...p, ratio: (p.cash_out + p.black_out + p.items_out) / Math.max(1, p.cash_in + p.black_in + p.items_in) }))
        .sort((a, b) => a.money_net - b.money_net).slice(0, 15);
      return { bigWithdrawals, takers };
    },

    async unparsed({ limit = 50 } = {}) {
      return all('SELECT message_id, channel_id, ts, raw FROM unparsed ORDER BY ts DESC LIMIT ?', [Number(limit)]);
    },
    async playerNames(q = '', limit = 25) {
      return (await all(`SELECT player, COUNT(*) AS n FROM transactions WHERE player LIKE ? GROUP BY player COLLATE NOCASE ORDER BY n DESC LIMIT ?`,
        [`%${q}%`, limit])).map((r) => r.player);
    },
    async coffreNames(q = '', limit = 25) {
      return (await all(`SELECT coffre, COUNT(*) AS n FROM transactions WHERE coffre LIKE ? GROUP BY coffre ORDER BY n DESC LIMIT ?`,
        [`%${q}%`, limit])).map((r) => r.coffre);
    },
  };
}
