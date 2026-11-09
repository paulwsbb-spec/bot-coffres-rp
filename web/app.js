/* global Chart */
const $ = (s) => document.querySelector(s);
const nf = new Intl.NumberFormat('fr-FR');
const money = (n) => `${nf.format(Math.round(n || 0))} $`;
// Montants affichés au dollar près (demande : "que tout se voie bien clair")
const compact = (n) => `${n < 0 ? '−' : ''}${money(Math.abs(n || 0))}`;
// Version abrégée réservée aux axes du graphique
const axis = (n) => {
  const a = Math.abs(n || 0);
  const s = a >= 1e6 ? `${(a / 1e6).toFixed(a >= 1e7 ? 0 : 1)} M` : a >= 1e4 ? `${Math.round(a / 1e3)} k` : nf.format(Math.round(a));
  return `${n < 0 ? '−' : ''}${s.replace('.', ',')} $`;
};
const signed = (n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${money(Math.abs(n))}`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ago = (ms) => {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${Math.max(s, 0)} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} j`;
};
const dateFmt = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const whatOf = (t) => (t.kind === 'money'
  ? `${money(t.amount)}${t.item === 'black_money' ? '<span class="tag">sale</span>' : ''}`
  : `${nf.format(t.quantity)}× ${esc(t.item)}`);

const state = { coffre: '', period: '30d', player: '', item: '', offset: 0, limit: 50, tlMode: 'money', itemMode: 'period', playerSort: 'activity' };
try { Object.assign(state, JSON.parse(localStorage.getItem('coffres-ui') || '{}'), { offset: 0 }); } catch { /* storage indisponible */ }
const persist = () => { try { localStorage.setItem('coffres-ui', JSON.stringify({ period: state.period, tlMode: state.tlMode, playerSort: state.playerSort })); } catch { /* */ } };

const qs = (extra = {}) => {
  const p = new URLSearchParams();
  const o = { coffre: state.coffre, period: state.period, player: state.player, item: state.item, ...extra };
  for (const [k, v] of Object.entries(o)) if (v !== '' && v != null) p.set(k, v);
  return p.toString();
};
const api = (path, extra) => fetch(`/api/${path}?${qs(extra)}`).then((r) => {
  if (r.status === 401) { location.href = '/login'; throw new Error('non connecté'); }
  if (!r.ok) throw new Error(r.status);
  return r.json();
});

/* ---------- Coffres ---------- */
async function loadCoffres() {
  const list = await api('coffres', { coffre: '', period: '', player: '', item: '' });
  const sel = $('#coffre');
  sel.innerHTML = '<option value="">Tous les coffres</option>' + list.map((c) => `<option ${c.coffre === state.coffre ? 'selected' : ''}>${esc(c.coffre)}</option>`).join('');
  $('#coffres').innerHTML = list.map((c) => {
    const bal = c.balance.total;
    return `<button class="coffre-card ${c.coffre === state.coffre ? 'on' : ''}" data-coffre="${esc(c.coffre)}">
      <div class="name">${esc(c.coffre)}<span>${nf.format(c.n)} mvts</span></div>
      <div class="bal ${bal < 0 ? 'neg' : ''}">${compact(bal)}</div>
      <div class="sub">dans le coffre · dernier ${c.last_ts ? ago(c.last_ts) : '—'}</div>
    </button>`;
  }).join('') + `<button class="coffre-card report-card" id="open-report" type="button">
      <div class="name">📊 Bilan semaine<span>ouvrir →</span></div>
      <div class="bal">Par joueur</div>
      <div class="sub">argent · crochetage · piratage</div>
    </button>`;
}

/* ---------- KPIs ---------- */
function kpi(label, value, hint, accent, cls = '') {
  return `<div class="kpi" style="--accent:${accent}"><div class="label">${label}</div><div class="value ${cls}" title="${esc(value)}">${value}</div><div class="hint">${hint}</div></div>`;
}
/** Carte d'un item clé : entrées / sorties sur la période, stock, et qui a déposé / pris */
function itemCard(icon, d) {
  const max = Math.max(1, ...d.players.map((p) => p.qty_in + p.qty_out));
  const rows = d.players.length
    ? d.players.map((p) => `<tr>
        <td><span class="link" data-player="${esc(p.player)}">${esc(p.player)}</span>
          <div class="bar" style="width:${Math.max(6, ((p.qty_in + p.qty_out) / max) * 100)}%"><i style="width:${(p.qty_in / Math.max(1, p.qty_in + p.qty_out)) * 100}%;background:var(--in)"></i><i style="flex:1;background:var(--out)"></i></div></td>
        <td class="num pos">${p.qty_in ? `+${nf.format(p.qty_in)}` : '—'}</td>
        <td class="num neg">${p.qty_out ? `−${nf.format(p.qty_out)}` : '—'}</td></tr>`).join('')
    : '<tr><td colspan="3" class="empty">Personne sur cette période</td></tr>';
  return `<article class="card item-card">
    <header class="card-h"><h2>${icon} ${esc(d.item)}</h2><span class="stock-badge">Stock : <b>${nf.format(d.stock)}</b></span></header>
    <div class="item-totals">
      <div><span class="muted">Déposés</span><b class="pos">+${nf.format(d.qty_in)}</b></div>
      <div><span class="muted">Pris</span><b class="neg">−${nf.format(d.qty_out)}</b></div>
    </div>
    <table class="who"><thead><tr><th>Par qui</th><th class="num">Déposé</th><th class="num">Pris</th></tr></thead><tbody>${rows}</tbody></table>
  </article>`;
}

/** Crochetage / piratage : suivent la semaine choisie (comme le classement) */
let keyReq = 0;
async function loadKeyItems() {
  if (!weeks.length) await loadWeeks();
  const id = ++keyReq;
  const week = state.week;
  const keys = await api('key-items', { week, period: '', player: '', item: '' }).catch(() => []);
  if (id !== keyReq) return;
  $('#key-items').innerHTML = keys.map((d, k) => itemCard(['🔓', '💻'][k] || '📦', d)).join('');
}

async function loadSummary() {
  const s = await api('summary');
  const out = s.cash_out + s.black_out;
  const total = s.cash_balance + s.black_balance;
  const since = s.anchored_at ? `solde saisi le ${dateFmt.format(s.anchored_at)}` : 'tape /solde pour régler le montant réel';
  $('#kpis').innerHTML = [
    kpi('💰 Argent dans le coffre', compact(total), `sale ${compact(s.black_balance)} · propre ${compact(s.cash_balance)}<br>${since}`, 'var(--brand)', total < 0 ? 'neg' : ''),
    kpi('Argent retiré', compact(out), `dont sale ${compact(s.black_out)}`, 'var(--out)', 'neg'),
    kpi('Items entrés / sortis', `${nf.format(s.items_in)} / ${nf.format(s.items_out)}`, `net ${s.items_in - s.items_out >= 0 ? '+' : ''}${nf.format(s.items_in - s.items_out)}`, 'var(--black)'),
    kpi('Joueurs actifs', nf.format(s.players), `${s.coffres} coffre(s) · ${nf.format(s.n)} mouvements`, 'var(--line-2)'),
  ].join('');
  $('#unparsed-n').textContent = nf.format(s.unparsed);
}

/* ---------- Timeline ---------- */
let chart;
async function loadTimeline() {
  const { rows, bucket } = await api('timeline');
  const labels = rows.map((r) => (bucket === 'hour' ? r.t.slice(11, 16) : r.t.slice(8, 10) + '/' + r.t.slice(5, 7)));
  const ds = {
    money: [
      { label: 'Dépôts', data: rows.map((r) => r.cash_in + r.black_in), backgroundColor: '#3ddc84' },
      { label: 'Retraits', data: rows.map((r) => -(r.cash_out + r.black_out)), backgroundColor: '#ff4d55' },
    ],
    items: [
      { label: 'Items entrés', data: rows.map((r) => r.items_in), backgroundColor: '#3ddc84' },
      { label: 'Items sortis', data: rows.map((r) => -r.items_out), backgroundColor: '#ff4d55' },
    ],
    count: [{ label: 'Mouvements', data: rows.map((r) => r.n), backgroundColor: '#e8e8e8' }],
  }[state.tlMode];
  const isMoney = state.tlMode === 'money';
  const cfg = {
    type: 'bar',
    data: { labels, datasets: ds.map((d) => ({ ...d, borderRadius: 3, maxBarThickness: 18 })) },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#d0d0d0', boxWidth: 10, boxHeight: 10, useBorderRadius: true, borderRadius: 2 } },
        tooltip: { backgroundColor: '#1a1a1a', borderColor: '#d71f26', borderWidth: 1, padding: 10,
          callbacks: { label: (c) => ` ${c.dataset.label} : ${isMoney ? money(Math.abs(c.raw)) : nf.format(Math.abs(c.raw))}` } },
      },
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { color: '#9a9a9a', maxRotation: 0, autoSkipPadding: 12 } },
        y: { stacked: true, grid: { color: '#222222' }, border: { display: false },
          ticks: { color: '#9a9a9a', callback: (v) => (isMoney ? axis(v) : nf.format(v)) } },
      },
    },
  };
  if (chart) chart.destroy();
  chart = new Chart($('#timeline'), cfg);
}

/* ---------- Classement hebdo (dimanche 19h → dimanche 19h), trié par argent déposé ---------- */
const dayFmt = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit' });
const weekLabel = (w) => (w.current ? 'Semaine en cours' : `Du ${dayFmt.format(w.start)} au ${dayFmt.format(w.end)}`);
let weeks = [];
let nextReset = 0;

async function loadWeeks() {
  weeks = await api('weeks', { period: '', player: '' });
  if (!weeks.some((w) => String(w.start) === String(state.week))) state.week = String(weeks[0]?.start || '');
  fillWeekSelect($('#week'), state.week, true);
  fillWeekSelect($('#week-items'), state.week);
}
function fillWeekSelect(sel, value, withTop = false) {
  if (!sel) return;
  sel.innerHTML = weeks.map((w) => `<option value="${w.start}" ${String(w.start) === String(value) ? 'selected' : ''}>${weekLabel(w)}${withTop && w.top ? ` · 🥇 ${esc(w.top.player)}` : ''}</option>`).join('');
}
const loadWeekly = () => loadWeeks().then(() => Promise.all([loadPlayers(), loadKeyItems()]));
const setWeek = (v) => { state.week = String(v); $('#week').value = state.week; $('#week-items').value = state.week; loadPlayers(); loadKeyItems(); };

/* ---------- Bilan de la semaine (fenêtre) ---------- */
let reportWeek = '';
async function openReport(week = reportWeek) {
  if (!weeks.length) await loadWeeks();
  reportWeek = String(week || weeks[0]?.start || '');
  fillWeekSelect($('#week-report'), reportWeek);
  const dlg = $('#report');
  if (!dlg.open) dlg.showModal();
  $('#report-body').innerHTML = '<div class="empty">Chargement…</div>';
  let r;
  try { r = await api('week-report', { week: reportWeek, period: '', player: '' }); }
  catch { $('#report-body').innerHTML = '<div class="empty">Bilan indisponible : relance le bot (demarrer.bat) pour activer cette fonction.</div>'; return; }
  const dfmt = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const pm = (i, o) => `${i ? `<b class="pos">+${nf.format(i)}</b>` : ''}${i && o ? ' ' : ''}${o ? `<b class="neg">−${nf.format(o)}</b>` : ''}${!i && !o ? '<span class="faint">—</span>' : ''}`;
  const tiles = [
    ['💵 Argent déposé', `<span class="pos">${compact(r.totals.deposited)}</span>`],
    ['💸 Argent retiré', `<span class="neg">${compact(r.totals.withdrawn)}</span>`],
    ...r.totals.keys.map((k, i) => [`${['🔓', '💻'][i] || '📦'} ${esc(k.item)}`, pm(k.in, k.out)]),
  ];
  $('#report-body').innerHTML = `
    <p class="muted report-range">${r.current ? '🟢 Semaine en cours' : '📁 Semaine archivée'} · du ${dfmt.format(r.start)} au ${dfmt.format(r.end)} · ${nf.format(r.totals.n)} mouvements</p>
    <div class="report-tiles">${tiles.map(([l, v]) => `<div><span class="muted">${l}</span><div class="v">${v}</div></div>`).join('')}</div>
    <div class="table-wrap report-table"><table>
      <thead><tr><th>#</th><th>Joueur</th><th class="num">Déposé</th><th class="num">Retiré</th>
        ${r.totals.keys.map((k, i) => `<th class="num">${['🔓', '💻'][i] || ''} ${esc((w => w.charAt(0).toUpperCase() + w.slice(1))(k.item.split(' ').pop()))}</th>`).join('')}
        <th class="num">Items +/−</th><th class="num">Mvts</th></tr></thead>
      <tbody>${r.players.map((p, k) => `<tr>
        <td class="medal">${['🥇', '🥈', '🥉'][k] && p.deposited > 0 ? ['🥇', '🥈', '🥉'][k] : `<span class="rank">${k + 1}</span>`}</td>
        <td><b>${esc(p.player)}</b></td>
        <td class="num pos">${p.deposited ? compact(p.deposited) : '<span class="faint">—</span>'}</td>
        <td class="num neg">${p.withdrawn ? compact(p.withdrawn) : '<span class="faint">—</span>'}</td>
        ${p.keys.map((x) => `<td class="num">${pm(x.in, x.out)}</td>`).join('')}
        <td class="num">${pm(p.items_in, p.items_out)}</td>
        <td class="num">${nf.format(p.n)}</td></tr>`).join('') || '<tr><td colspan="9" class="empty">Aucun mouvement cette semaine pour l\'instant</td></tr>'}</tbody>
    </table></div>`;
}

function renderCountdown() {
  const w = weeks.find((x) => String(x.start) === String(state.week));
  if (!w) { $('#week-info').textContent = ''; return; }
  if (!w.current) { $('#week-info').innerHTML = `📁 Semaine archivée · total déposé <b>${compact(w.deposited)}</b>`; return; }
  const ms = Math.max(0, nextReset - Date.now());
  if (nextReset && ms === 0) { nextReset = 0; state.week = ''; loadWeekly(); return; } // dimanche 19h : nouvelle semaine
  const d = Math.floor(ms / 86400e3); const h = Math.floor(ms / 3600e3) % 24; const m = Math.floor(ms / 60e3) % 60;
  $('#week-info').innerHTML = `⏳ Nouvelle semaine dans <b>${d ? `${d} j ` : ''}${h} h ${String(m).padStart(2, '0')}</b> (dimanche 19h) · total déposé <b>${compact(w.deposited)}</b>`;
}
setInterval(renderCountdown, 30000);

let rankReq = 0;
async function loadPlayers() {
  if (!weeks.length) await loadWeeks();
  const id = ++rankReq;
  const week = state.week;
  const { rows, next_reset: nr } = await api('ranking', { week, period: '', player: '' });
  if (id !== rankReq || week !== state.week) return; // réponse périmée (semaine changée entre-temps)
  $('#week').value = String(week);
  nextReset = nr;
  renderCountdown();
  const ranked = rows.filter((p) => p.deposited > 0);
  if (!ranked.length) { $('#players').innerHTML = '<tr><td class="empty">Aucun dépôt d\'argent cette semaine pour l\'instant</td></tr>'; return; }
  const max = Math.max(...ranked.map((p) => p.deposited), 1);
  const medal = (r) => ['🥇', '🥈', '🥉'][r - 1] || `<span class="rank">${r}</span>`;
  $('#players').innerHTML = `<thead><tr><th>#</th><th>Joueur</th><th class="num">Argent déposé</th><th class="num">Retiré</th><th class="num">Mvts</th></tr></thead><tbody>` +
    ranked.map((p, k) => `<tr class="${k < 3 ? 'podium' : ''}"><td class="medal">${medal(k + 1)}</td>
      <td><span class="link" data-player="${esc(p.player)}">${esc(p.player)}</span>
        <div class="bar" style="width:${Math.max(4, (p.deposited / max) * 100)}%"><i style="flex:1;background:var(--in)"></i></div></td>
      <td class="num pos"><b>${compact(p.deposited)}</b></td>
      <td class="num ${p.withdrawn ? 'neg' : 'muted'}">${p.withdrawn ? compact(p.withdrawn) : '—'}</td>
      <td class="num">${nf.format(p.n)}</td></tr>`).join('') + '</tbody>';
}

/* ---------- Items ---------- */
async function loadItems() {
  const stock = state.itemMode === 'stock';
  const rows = await api(stock ? 'stock' : 'items', { item: '' });
  if (!rows.length) { $('#items').innerHTML = '<tr><td class="empty">Aucun item</td></tr>'; return; }
  $('#items').innerHTML = `<thead><tr><th>Item</th><th class="num">Entrées</th><th class="num">Sorties</th><th class="num">${stock ? 'Stock estimé' : 'Net'}</th><th class="num">Joueurs</th></tr></thead><tbody>` +
    rows.map((r) => `<tr><td><span class="link" data-item="${esc(r.item)}">${esc(r.item)}</span></td>
      <td class="num pos">+${nf.format(r.qty_in)}</td><td class="num neg">−${nf.format(r.qty_out)}</td>
      <td class="num ${r.net < 0 ? 'neg' : ''}" ${stock && r.net < 0 ? 'title="Négatif : items présents avant le début des logs"' : ''}>${r.net > 0 ? '+' : ''}${nf.format(r.net)}</td>
      <td class="num">${r.players}</td></tr>`).join('') + '</tbody>';
}

/* ---------- Heatmap ---------- */
async function loadHeatmap() {
  const rows = await api('heatmap');
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  rows.forEach((r) => { grid[r.dow][r.hour] = r.n; });
  const max = Math.max(1, ...rows.map((r) => r.n));
  const days = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
  const order = [1, 2, 3, 4, 5, 6, 0];
  let html = '<div></div>' + Array.from({ length: 24 }, (_, h) => `<div class="h">${h % 3 === 0 ? h : ''}</div>`).join('');
  order.forEach((d, k) => {
    html += `<div class="lbl">${days[k]}</div>` + grid[d].map((n, h) => {
      const a = n ? 0.12 + 0.88 * (n / max) : 0;
      return `<div class="c" title="${days[k]} ${h}h : ${n} mouvements" style="${n ? `background:rgba(215,31,38,${a.toFixed(2)})` : ''}"></div>`;
    }).join('');
  });
  $('#heatmap').innerHTML = html;
}

/* ---------- Alertes ---------- */
async function loadAlerts() {
  const [{ bigWithdrawals, takers }, status] = await Promise.all([api('alerts', { player: '' }), fetch('/api/status').then((r) => r.json())]);
  $('#alert-rule').textContent = `seuil ${compact(status.alerts?.moneyWithdrawThreshold)} / ${status.alerts?.itemWithdrawThreshold} items`;
  $('#big').innerHTML = bigWithdrawals.map((t) => `<li><div><b class="link" data-player="${esc(t.player)}">${esc(t.player || '?')}</b><small>${esc(t.coffre)} · il y a ${ago(t.ts)}</small></div><div class="r neg">${whatOf(t)}</div></li>`).join('') || '<li class="empty">Rien à signaler</li>';
  $('#takers').innerHTML = takers.map((p) => `<li><div><b class="link" data-player="${esc(p.player)}">${esc(p.player)}</b><small>a déposé ${compact(p.cash_in + p.black_in)} · items ${p.item_net >= 0 ? '+' : ''}${nf.format(p.item_net)}</small></div><div class="r ${p.money_net < 0 ? 'neg' : 'pos'}">${p.money_net > 0 ? '+' : ''}${compact(p.money_net)}<small>${p.cash_in + p.black_in > 0 ? `×${((p.cash_out + p.black_out) / (p.cash_in + p.black_in)).toFixed(1)} pris/déposé` : 'rien déposé'}</small></div></li>`).join('') || '<li class="empty">Personne</li>';
}

/* ---------- Transactions ---------- */
const txFilters = () => ({ q: $('#q').value.trim(), action: $('#f-action').value, kind: $('#f-kind').value });
async function loadTx() {
  const { total, rows } = await api('transactions', { ...txFilters(), limit: state.limit, offset: state.offset });
  $('#tx-total').textContent = `· ${nf.format(total)}`;
  $('#tx').innerHTML = `<thead><tr><th>Date</th><th>Type</th><th>Joueur</th><th>Coffre</th><th class="num">Quantité / montant</th></tr></thead><tbody>` +
    (rows.map((t) => `<tr><td class="muted">${dateFmt.format(t.ts)}</td>
      <td><span class="pill ${t.action === 'deposit' ? 'in' : 'out'}">${t.action === 'deposit' ? 'Dépôt' : 'Retrait'}</span></td>
      <td><span class="link" data-player="${esc(t.player)}">${esc(t.player || '?')}</span>${t.player_id ? ` <span class="muted">#${esc(t.player_id)}</span>` : ''}</td>
      <td><span class="link" data-coffre="${esc(t.coffre)}">${esc(t.coffre)}</span></td>
      <td class="num ${t.action === 'deposit' ? 'pos' : 'neg'}">${t.action === 'deposit' ? '+' : '−'}${whatOf(t)}</td></tr>`).join('') ||
      '<tr><td colspan="5" class="empty">Aucun mouvement</td></tr>') + '</tbody>';
  const page = Math.floor(state.offset / state.limit) + 1;
  $('#page').textContent = `Page ${page} / ${Math.max(1, Math.ceil(total / state.limit))}`;
  $('#prev').disabled = state.offset === 0;
  $('#next').disabled = state.offset + state.limit >= total;
}

async function exportCsv() {
  const { rows } = await api('transactions', { ...txFilters(), limit: 500, offset: 0 });
  const head = ['date', 'action', 'joueur', 'id_joueur', 'coffre', 'type', 'item', 'quantite', 'montant'];
  const lines = rows.map((t) => [new Date(t.ts).toISOString(), t.action, t.player, t.player_id, t.coffre, t.kind, t.item, t.quantity, t.amount ?? '']
    .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(';'));
  const blob = new Blob(['﻿' + [head.join(';'), ...lines].join('\n')], { type: 'text/csv' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `coffres-${Date.now()}.csv` });
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------- Non reconnus ---------- */
async function loadUnparsed() {
  const rows = await api('unparsed', { limit: 30 });
  $('#unparsed').innerHTML = rows.map((r) => `<li>${esc(r.raw)}</li>`).join('') || '<li>Aucun 🎉</li>';
}

/* ---------- Feed temps réel ---------- */
let feedN = 0;
async function loadFeed() {
  const { rows } = await api('transactions', { limit: 25, period: '' });
  $('#feed').innerHTML = '';
  rows.reverse().forEach((t) => addFeed(t, false));
}
function addFeed(t, flash = true) {
  const li = document.createElement('li');
  if (flash) li.className = 'flash';
  const inn = t.action === 'deposit';
  li.innerHTML = `<div class="ic ${inn ? 'in' : 'out'}">${inn ? '+' : '−'}</div>
    <div><div class="who">${esc(t.player || '?')}</div><div class="what">${whatOf(t)} · ${esc(t.coffre)}</div></div>
    <time data-ts="${t.ts}">${ago(t.ts)}</time>`;
  $('#feed').prepend(li);
  while ($('#feed').children.length > 60) $('#feed').lastChild.remove();
  if (flash) $('#feed-count').textContent = `${++feedN} nouveau${feedN > 1 ? 'x' : ''}`;
}
setInterval(() => document.querySelectorAll('#feed time').forEach((el) => { el.textContent = ago(Number(el.dataset.ts)); }), 15000);

/* ---------- Orchestration ---------- */
function renderChips() {
  const chips = [];
  if (state.player) chips.push(['player', `Joueur : ${state.player}`]);
  if (state.item) chips.push(['item', `Item : ${state.item}`]);
  $('#chips').innerHTML = chips.map(([k, l]) => `<span class="chip">${esc(l)}<button data-clear="${k}" aria-label="Retirer">×</button></span>`).join('');
}

async function refreshAll() {
  renderChips();
  const jobs = [loadCoffres(), loadSummary(), loadTimeline(), loadWeekly(), loadItems(), loadHeatmap(), loadAlerts(), loadTx(), loadUnparsed()];
  const res = await Promise.allSettled(jobs);
  res.filter((r) => r.status === 'rejected').forEach((r) => console.error(r.reason));
}

let pending;
const softRefresh = () => {
  clearTimeout(pending);
  pending = setTimeout(() => Promise.allSettled([loadCoffres(), loadSummary(), loadTimeline(), loadWeekly(), loadItems(), loadAlerts(), state.offset === 0 ? loadTx() : null]), 1500);
};

async function loadStatus() {
  try {
    const s = await fetch('/api/status').then((r) => r.json());
    $('#status').textContent = s.bot ? `Bot : ${s.bot}${s.backfilling ? ' · import de l\'historique…' : ''}` : 'Bot hors ligne · données en base';
  } catch { $('#status').textContent = 'Serveur injoignable'; }
}

// Version Cloudflare : pas de flux continu → on vérifie les nouveaux mouvements toutes les 30 s
let lastSeenId = 0;
let polling = null;
async function pollNew() {
  try {
    const { rows } = await api('transactions', { limit: 25, period: '', player: '', coffre: '' });
    const fresh = rows.filter((t) => t.id > lastSeenId).reverse();
    if (lastSeenId && fresh.length) { fresh.forEach((t) => addFeed(t)); softRefresh(); }
    if (rows.length) lastSeenId = Math.max(lastSeenId, ...rows.map((t) => t.id));
    $('.live').classList.add('on');
    $('#live-label').textContent = 'Auto';
  } catch { $('.live').classList.remove('on'); }
}
function startPolling() {
  if (polling) return;
  pollNew();
  polling = setInterval(pollNew, 30000);
}

function connectStream() {
  const es = new EventSource('/api/stream');
  let opened = false;
  es.onopen = () => { opened = true; $('.live').classList.add('on'); $('#live-label').textContent = 'Live'; };
  es.onerror = () => {
    $('.live').classList.remove('on');
    $('#live-label').textContent = 'Reconnexion…';
    if (!opened || es.readyState === EventSource.CLOSED) { es.close(); startPolling(); }
  };
  es.addEventListener('tx', (e) => {
    const txs = JSON.parse(e.data);
    txs.forEach((t) => addFeed(t));
    const relevant = txs.some((t) => (!state.coffre || t.coffre === state.coffre) && (!state.player || t.player === state.player));
    if (relevant) softRefresh();
  });
  es.addEventListener('refresh', () => { refreshAll(); loadStatus(); });
}

/* ---------- Événements UI ---------- */
function setSeg(sel, attr, value) { document.querySelectorAll(`${sel} button`).forEach((b) => b.classList.toggle('on', b.dataset[attr] === value)); }

$('#period').addEventListener('click', (e) => {
  const p = e.target.closest('button')?.dataset.p; if (!p) return;
  state.period = p; state.offset = 0; setSeg('#period', 'p', p); persist(); refreshAll();
});
$('#tl-mode').addEventListener('click', (e) => {
  const m = e.target.closest('button')?.dataset.m; if (!m) return;
  state.tlMode = m; setSeg('#tl-mode', 'm', m); persist(); loadTimeline();
});
$('#item-mode').addEventListener('click', (e) => {
  const m = e.target.closest('button')?.dataset.m; if (!m) return;
  state.itemMode = m; setSeg('#item-mode', 'm', m); loadItems();
});
$('#coffre').addEventListener('change', (e) => { state.coffre = e.target.value; state.offset = 0; refreshAll(); });
$('#week').addEventListener('change', (e) => setWeek(e.target.value));
$('#week-items').addEventListener('change', (e) => setWeek(e.target.value));
$('#week-report').addEventListener('change', (e) => openReport(e.target.value));
$('#report-close').addEventListener('click', () => $('#report').close());
$('#report').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); }); // clic hors de la fenêtre
document.addEventListener('click', (e) => { if (e.target.closest('#open-report')) openReport(''); });
let qTimer;
$('#q').addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(() => { state.offset = 0; loadTx(); }, 250); });
$('#f-action').addEventListener('change', () => { state.offset = 0; loadTx(); });
$('#f-kind').addEventListener('change', () => { state.offset = 0; loadTx(); });
$('#prev').addEventListener('click', () => { state.offset = Math.max(0, state.offset - state.limit); loadTx(); });
$('#next').addEventListener('click', () => { state.offset += state.limit; loadTx(); });
$('#csv').addEventListener('click', exportCsv);

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-player],[data-coffre],[data-item],[data-clear]');
  if (!el) return;
  if (el.dataset.clear) state[el.dataset.clear] = '';
  else if (el.dataset.player !== undefined) { if (!el.dataset.player) return; state.player = el.dataset.player; }
  else if (el.dataset.item !== undefined) state.item = el.dataset.item;
  else if (el.dataset.coffre !== undefined) state.coffre = state.coffre === el.dataset.coffre && el.classList.contains('coffre-card') ? '' : el.dataset.coffre;
  state.offset = 0;
  refreshAll();
  if (!el.dataset.clear) window.scrollTo({ top: 0, behavior: 'smooth' });
});

/* ---------- Init ---------- */
Chart.defaults.font.family = 'Inter, system-ui, sans-serif';
setSeg('#period', 'p', state.period);
setSeg('#tl-mode', 'm', state.tlMode);
refreshAll();
loadFeed();
loadStatus();
setInterval(loadStatus, 30000);
connectStream();
