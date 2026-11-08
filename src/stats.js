// Requêtes statistiques partagées par le bot (slash commands) et le dashboard (API).

const MONEY_SUMS = `
  COALESCE(SUM(CASE WHEN kind='money' AND item='cash'        AND action='deposit'  THEN amount END),0) AS cash_in,
  COALESCE(SUM(CASE WHEN kind='money' AND item='cash'        AND action='withdraw' THEN amount END),0) AS cash_out,
  COALESCE(SUM(CASE WHEN kind='money' AND item='black_money' AND action='deposit'  THEN amount END),0) AS black_in,
  COALESCE(SUM(CASE WHEN kind='money' AND item='black_money' AND action='withdraw' THEN amount END),0) AS black_out,
  COALESCE(SUM(CASE WHEN kind='item' AND action='deposit'  THEN quantity END),0) AS items_in,
  COALESCE(SUM(CASE WHEN kind='item' AND action='withdraw' THEN quantity END),0) AS items_out`;

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

/** Convertit "24h" / "7d" / "30d" / "all" en { from } */
export function periodToRange(period) {
  const m = /^(\d+)\s*(h|d|j|w|m)$/i.exec(String(period || ''));
  if (!m) return {};
  const n = Number(m[1]);
  const unit = { h: 3600e3, d: 86400e3, j: 86400e3, w: 7 * 86400e3, m: 30 * 86400e3 }[m[2].toLowerCase()];
  return { from: Date.now() - n * unit };
}

/** Début de la semaine de classement contenant `ts` : le dimanche 19h précédent (heure du PC). */
export function weekStart(ts = Date.now()) {
  const d = new Date(ts);
  const s = new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay(), 19, 0, 0, 0);
  if (s.getTime() > ts) s.setDate(s.getDate() - 7);
  return s.getTime();
}
export function weekEnd(start) {
  const e = new Date(start);
  e.setDate(e.getDate() + 7);
  return e.getTime();
}

export function createStats(db) {
  const all = (sql, params = []) => db.prepare(sql).all(...params);
  const get = (sql, params = []) => db.prepare(sql).get(...params);

  /**
   * Argent réellement dans le coffre.
   * Si un solde de départ a été saisi (/solde) : solde saisi + dépôts − retraits faits APRÈS la saisie.
   * Sinon : total des dépôts − total des retraits depuis le début des logs.
   */
  function balance(coffre = null) {
    const names = coffre ? [coffre] : [...new Set([
      ...all('SELECT DISTINCT coffre FROM transactions').map((r) => r.coffre),
      ...all('SELECT DISTINCT coffre FROM anchors').map((r) => r.coffre),
    ])];
    const out = { cash: 0, black: 0, anchored_at: null };
    for (const c of names) {
      for (const [item, key] of [['cash', 'cash'], ['black_money', 'black']]) {
        const a = get('SELECT amount, ts FROM anchors WHERE coffre = ? AND item = ?', [c, item]);
        const s = get(`SELECT COALESCE(SUM(CASE WHEN action='deposit' THEN amount END),0) AS i,
                              COALESCE(SUM(CASE WHEN action='withdraw' THEN amount END),0) AS o
                       FROM transactions WHERE kind='money' AND coffre = ? AND item = ? AND ts > ?`, [c, item, a ? a.ts : -1]);
        out[key] += (a ? a.amount : 0) + s.i - s.o;
        if (a) out.anchored_at = Math.max(out.anchored_at || 0, a.ts);
      }
    }
    out.total = out.cash + out.black;
    return out;
  }

  return {
    balance,

    setAnchor(coffre, item, amount, ts = Date.now()) {
      db.prepare(`INSERT INTO anchors (coffre, item, amount, ts) VALUES (?,?,?,?)
        ON CONFLICT(coffre, item) DO UPDATE SET amount = excluded.amount, ts = excluded.ts`).run(coffre, item, amount, ts);
    },

    coffres() {
      return all(`SELECT coffre, COUNT(*) AS n, MAX(ts) AS last_ts, ${MONEY_SUMS}
                  FROM transactions GROUP BY coffre ORDER BY n DESC`)
        .map((c) => ({ ...c, balance: balance(c.coffre) }));
    },

    summary(f) {
      const w = buildWhere(f);
      const s = get(`SELECT COUNT(*) AS n, COUNT(DISTINCT player) AS players,
                     COUNT(DISTINCT coffre) AS coffres, MIN(ts) AS first_ts, MAX(ts) AS last_ts, ${MONEY_SUMS}
                     FROM transactions ${w.sql}`, w.params);
      // Argent dans le coffre = solde réel (indépendant de la période)
      const bal = balance(f.coffre || null);
      s.cash_balance = bal.cash;
      s.black_balance = bal.black;
      s.anchored_at = bal.anchored_at;
      const wb = buildWhere({ ...f, from: null });
      const b = get(`SELECT ${MONEY_SUMS} FROM transactions ${wb.sql}`, wb.params);
      s.items_balance = b.items_in - b.items_out;
      s.unparsed = get(`SELECT COUNT(*) AS n FROM unparsed`).n;
      return s;
    },

    timeline(f) {
      const span = (f.to || Date.now()) - (f.from || get('SELECT MIN(ts) AS t FROM transactions').t || Date.now());
      const fmt = span <= 3 * 86400e3 ? '%Y-%m-%d %H:00' : '%Y-%m-%d';
      const w = buildWhere(f);
      return {
        bucket: span <= 3 * 86400e3 ? 'hour' : 'day',
        rows: all(`SELECT strftime('${fmt}', ts/1000, 'unixepoch', 'localtime') AS t, COUNT(*) AS n, ${MONEY_SUMS}
                   FROM transactions ${w.sql} GROUP BY t ORDER BY t`, w.params),
      };
    },

    players(f, { sort = 'activity', limit = 50 } = {}) {
      const order = {
        activity: 'n DESC',
        deposit: '(cash_in + black_in) DESC',
        withdraw: '(cash_out + black_out) DESC',
        net: '(cash_in + black_in - cash_out - black_out) ASC',
        items_out: 'items_out DESC',
      }[sort] || 'n DESC';
      const w = buildWhere(f, ['player IS NOT NULL']);
      return all(`SELECT player, MAX(player_id) AS player_id, COUNT(*) AS n, MAX(ts) AS last_ts,
                  COUNT(DISTINCT coffre) AS coffres, ${MONEY_SUMS}
                  FROM transactions ${w.sql} GROUP BY player COLLATE NOCASE ORDER BY ${order} LIMIT ?`,
      [...w.params, Number(limit)]);
    },

    /** Semaines de classement (la plus récente d'abord), avec le total déposé et le n°1 */
    weeks(f = {}) {
      const first = get('SELECT MIN(ts) AS t FROM transactions').t;
      if (!first) return [];
      const out = [];
      for (let s = weekStart(Date.now()); s >= weekStart(first); ) {
        const e = weekEnd(s);
        const top = this.players({ ...f, from: s, to: e - 1 }, { sort: 'deposit', limit: 1 })[0];
        const w = buildWhere({ ...f, from: s, to: e - 1 }, ["kind = 'money'", "action = 'deposit'"]);
        out.push({ start: s, end: e, current: out.length === 0, deposited: get(`SELECT COALESCE(SUM(amount),0) AS v FROM transactions ${w.sql}`, w.params).v,
          top: top && top.cash_in + top.black_in > 0 ? { player: top.player, deposited: top.cash_in + top.black_in } : null });
        const p = new Date(s); p.setDate(p.getDate() - 7); s = p.getTime();
      }
      return out;
    },

    /** Classement d'une semaine : joueurs triés par argent déposé */
    ranking(start = weekStart(), f = {}, limit = 50) {
      return this.players({ ...f, from: start, to: weekEnd(start) - 1 }, { sort: 'deposit', limit })
        .map((p, k) => ({ rank: k + 1, ...p, deposited: p.cash_in + p.black_in, withdrawn: p.cash_out + p.black_out }));
    },

    /** Détail d'un item : entrées/sorties sur la période, stock, et qui a déposé / pris */
    itemDetail(f, item) {
      const g = { ...f, item, kind: 'item' };
      const w = buildWhere(g);
      const t = get(`SELECT COALESCE(SUM(CASE WHEN action='deposit' THEN quantity END),0) AS qty_in,
                            COALESCE(SUM(CASE WHEN action='withdraw' THEN quantity END),0) AS qty_out
                     FROM transactions ${w.sql}`, w.params);
      const ws = buildWhere({ ...g, from: null });
      const s = get(`SELECT COALESCE(SUM(CASE WHEN action='deposit' THEN quantity ELSE -quantity END),0) AS stock FROM transactions ${ws.sql}`, ws.params);
      const wp = buildWhere(g, ['player IS NOT NULL']);
      const players = all(`SELECT player,
                             COALESCE(SUM(CASE WHEN action='deposit' THEN quantity END),0) AS qty_in,
                             COALESCE(SUM(CASE WHEN action='withdraw' THEN quantity END),0) AS qty_out
                           FROM transactions ${wp.sql} GROUP BY player COLLATE NOCASE
                           ORDER BY (qty_in + qty_out) DESC LIMIT 8`, wp.params);
      return { item, ...t, stock: s.stock, players };
    },

    items(f, { limit = 100 } = {}) {
      const w = buildWhere(f, ["kind = 'item'"]);
      return all(`SELECT item,
                  COALESCE(SUM(CASE WHEN action='deposit'  THEN quantity END),0) AS qty_in,
                  COALESCE(SUM(CASE WHEN action='withdraw' THEN quantity END),0) AS qty_out,
                  COUNT(*) AS n, COUNT(DISTINCT player) AS players, MAX(ts) AS last_ts
                  FROM transactions ${w.sql} GROUP BY item COLLATE NOCASE
                  ORDER BY (qty_in + qty_out) DESC LIMIT ?`, [...w.params, Number(limit)])
        .map((r) => ({ ...r, net: r.qty_in - r.qty_out }));
    },

    /** Stock estimé (depuis le début des logs) : entrées - sorties par item */
    stock(f) {
      return this.items({ ...f, from: null }, { limit: 500 }).sort((a, b) => b.net - a.net);
    },

    heatmap(f) {
      const w = buildWhere(f);
      return all(`SELECT CAST(strftime('%w', ts/1000, 'unixepoch', 'localtime') AS INTEGER) AS dow,
                  CAST(strftime('%H', ts/1000, 'unixepoch', 'localtime') AS INTEGER) AS hour, COUNT(*) AS n
                  FROM transactions ${w.sql} GROUP BY dow, hour`, w.params);
    },

    transactions(f, { limit = 50, offset = 0 } = {}) {
      const w = buildWhere(f);
      const total = get(`SELECT COUNT(*) AS n FROM transactions ${w.sql}`, w.params).n;
      const rows = all(`SELECT id, ts, coffre, player, player_id, action, kind, item, quantity, amount, message_id
                        FROM transactions ${w.sql} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`,
      [...w.params, Math.min(Number(limit), 500), Number(offset)]);
      return { total, rows };
    },

    /** Alertes : gros retraits + joueurs qui prennent beaucoup plus qu'ils ne déposent */
    alerts(f, cfg) {
      const t = cfg.alerts || {};
      const w = buildWhere(f, [`action = 'withdraw'`,
        `((kind='money' AND amount >= ${Number(t.moneyWithdrawThreshold) || 1e12})
          OR (kind='item' AND quantity >= ${Number(t.itemWithdrawThreshold) || 1e12}))`]);
      const bigWithdrawals = all(`SELECT id, ts, coffre, player, kind, item, quantity, amount FROM transactions
                                  ${w.sql} ORDER BY ts DESC LIMIT 30`, w.params);
      const takers = this.players(f, { sort: 'net', limit: 200 })
        .map((p) => ({ ...p, money_net: p.cash_in + p.black_in - p.cash_out - p.black_out, item_net: p.items_in - p.items_out }))
        .filter((p) => p.money_net < 0 || p.item_net < -Number(t.itemWithdrawThreshold || 50))
        .map((p) => ({ ...p, ratio: (p.cash_out + p.black_out + p.items_out) / Math.max(1, p.cash_in + p.black_in + p.items_in) }))
        .sort((a, b) => a.money_net - b.money_net)
        .slice(0, 15);
      return { bigWithdrawals, takers };
    },

    unparsed({ limit = 50 } = {}) {
      return all(`SELECT message_id, channel_id, ts, raw FROM unparsed ORDER BY ts DESC LIMIT ?`, [Number(limit)]);
    },

    playerNames(q = '', limit = 25) {
      return all(`SELECT player, COUNT(*) AS n FROM transactions WHERE player LIKE ? GROUP BY player COLLATE NOCASE ORDER BY n DESC LIMIT ?`,
        [`%${q}%`, limit]).map((r) => r.player);
    },
    coffreNames(q = '', limit = 25) {
      return all(`SELECT coffre, COUNT(*) AS n FROM transactions WHERE coffre LIKE ? GROUP BY coffre ORDER BY n DESC LIMIT ?`,
        [`%${q}%`, limit]).map((r) => r.coffre);
    },
  };
}
