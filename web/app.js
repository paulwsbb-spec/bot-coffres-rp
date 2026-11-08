/* global Chart */
const $ = (s) => document.querySelector(s);
const nf = new Intl.NumberFormat('fr-FR');
const money = (n) => `${nf.format(Math.round(n || 0))} $`;
const compact = (n) => {
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
const api = (path, extra) => fetch(`/api/${path}?${qs(extra)}`).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });

/* ---------- Coffres ---------- */
async function loadCoffres() {
  const list = await api('coffres', { coffre: '', period: '', player: '', item: '' });
  const sel = $('#coffre');
  sel.innerHTML = '<option value="">Tous les coffres</option>' + list.map((c) => `<option ${c.coffre === state.coffre ? 'selected' : ''}>${esc(c.coffre)}</option>`).join('');
  $('#coffres').innerHTML = list.map((c) => {
    const bal = c.cash_in - c.cash_out + c.black_in - c.black_out;
    return `<button class="coffre-card ${c.coffre === state.coffre ? 'on' : ''}" data-coffre="${esc(c.coffre)}">
      <div class="name">${esc(c.coffre)}<span>${nf.format(c.n)} mvts</span></div>
      <div class="bal ${bal < 0 ? 'neg' : ''}">${compact(bal)}</div>
      <div class="sub">solde estimé · dernier ${c.last_ts ? ago(c.last_ts) : '—'}</div>
    </button>`;
  }).join('');
}

/* ---------- KPIs ---------- */
function kpi(label, value, hint, accent, cls = '') {
  return `<div class="kpi" style="--accent:${accent}"><div class="label">${label}</div><div class="value ${cls}" title="${esc(value)}">${value}</div><div class="hint">${hint}</div></div>`;
}
async function loadSummary() {
  const s = await api('summary');
  const inn = s.cash_in + s.black_in;
  const out = s.cash_out + s.black_out;
  const net = inn - out;
  $('#kpis').innerHTML = [
    kpi('Argent déposé', compact(inn), `dont sale ${compact(s.black_in)}`, 'var(--in)', 'pos'),
    kpi('Argent retiré', compact(out), `dont sale ${compact(s.black_out)}`, 'var(--out)', 'neg'),
    kpi('Bilan période', `${net >= 0 ? '+' : ''}${compact(net)}`, `${nf.format(s.n)} mouvements`, net >= 0 ? 'var(--in)' : 'var(--out)', net >= 0 ? 'pos' : 'neg'),
    kpi(state.player ? 'Bilan total (historique)' : 'Solde estimé', compact(s.cash_balance + s.black_balance), `propre ${compact(s.cash_balance)} · sale ${compact(s.black_balance)}`, 'var(--brand)'),
    kpi('Items entrés / sortis', `${nf.format(s.items_in)} / ${nf.format(s.items_out)}`, `net ${s.items_in - s.items_out >= 0 ? '+' : ''}${nf.format(s.items_in - s.items_out)}`, 'var(--black)'),
    kpi('Joueurs actifs', nf.format(s.players), `${s.coffres} coffre(s)`, 'var(--line-2)'),
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
      { label: 'Dépôts', data: rows.map((r) => r.cash_in + r.black_in), backgroundColor: '#22c55e' },
      { label: 'Retraits', data: rows.map((r) => -(r.cash_out + r.black_out)), backgroundColor: '#f04545' },
    ],
    items: [
      { label: 'Items entrés', data: rows.map((r) => r.items_in), backgroundColor: '#22c55e' },
      { label: 'Items sortis', data: rows.map((r) => -r.items_out), backgroundColor: '#f04545' },
    ],
    count: [{ label: 'Mouvements', data: rows.map((r) => r.n), backgroundColor: '#f5b301' }],
  }[state.tlMode];
  const isMoney = state.tlMode === 'money';
  const cfg = {
    type: 'bar',
    data: { labels, datasets: ds.map((d) => ({ ...d, borderRadius: 3, maxBarThickness: 18 })) },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#8a90a0', boxWidth: 10, boxHeight: 10, useBorderRadius: true, borderRadius: 2 } },
        tooltip: { backgroundColor: '#1b1e25', borderColor: '#323744', borderWidth: 1, padding: 10,
          callbacks: { label: (c) => ` ${c.dataset.label} : ${isMoney ? money(Math.abs(c.raw)) : nf.format(Math.abs(c.raw))}` } },
      },
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { color: '#5c6273', maxRotation: 0, autoSkipPadding: 12 } },
        y: { stacked: true, grid: { color: '#22252d' }, border: { display: false },
          ticks: { color: '#5c6273', callback: (v) => (isMoney ? compact(v) : nf.format(v)) } },
      },
    },
  };
  if (chart) chart.destroy();
  chart = new Chart($('#timeline'), cfg);
}

/* ---------- Joueurs ---------- */
async function loadPlayers() {
  const rows = await api('players', { sort: state.playerSort, limit: 50, player: '' });
  if (!rows.length) { $('#players').innerHTML = '<tr><td class="empty">Aucune donnée</td></tr>'; return; }
  const max = Math.max(...rows.map((p) => p.cash_in + p.black_in + p.cash_out + p.black_out), 1);
  $('#players').innerHTML = `<thead><tr><th>Joueur</th><th class="num">Mvts</th><th class="num">Déposé</th><th class="num">Retiré</th><th class="num">Bilan</th><th class="num">Items +/−</th></tr></thead><tbody>` +
    rows.map((p) => {
      const inn = p.cash_in + p.black_in; const out = p.cash_out + p.black_out; const net = inn - out;
      return `<tr><td><span class="link" data-player="${esc(p.player)}">${esc(p.player)}</span>
        <div class="bar" style="width:${Math.max(4, ((inn + out) / max) * 100)}%"><i style="width:${(inn / Math.max(inn + out, 1)) * 100}%;background:var(--in)"></i><i style="flex:1;background:var(--out)"></i></div></td>
        <td class="num">${nf.format(p.n)}</td><td class="num pos">${compact(inn)}</td><td class="num neg">${compact(out)}</td>
        <td class="num ${net >= 0 ? 'pos' : 'neg'}">${net >= 0 ? '+' : ''}${compact(net)}</td>
        <td class="num"><span class="pos">+${nf.format(p.items_in)}</span> / <span class="neg">−${nf.format(p.items_out)}</span></td></tr>`;
    }).join('') + '</tbody>';
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
      return `<div class="c" title="${days[k]} ${h}h : ${n} mouvements" style="${n ? `background:rgba(245,179,1,${a.toFixed(2)})` : ''}"></div>`;
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
  const jobs = [loadCoffres(), loadSummary(), loadTimeline(), loadPlayers(), loadItems(), loadHeatmap(), loadAlerts(), loadTx(), loadUnparsed()];
  const res = await Promise.allSettled(jobs);
  res.filter((r) => r.status === 'rejected').forEach((r) => console.error(r.reason));
}

let pending;
const softRefresh = () => {
  clearTimeout(pending);
  pending = setTimeout(() => Promise.allSettled([loadCoffres(), loadSummary(), loadTimeline(), loadPlayers(), loadItems(), loadAlerts(), state.offset === 0 ? loadTx() : null]), 1500);
};

async function loadStatus() {
  try {
    const s = await fetch('/api/status').then((r) => r.json());
    $('#status').textContent = s.bot ? `Bot : ${s.bot}${s.backfilling ? ' · import de l\'historique…' : ''}` : 'Bot hors ligne · données en base';
  } catch { $('#status').textContent = 'Serveur injoignable'; }
}

function connectStream() {
  const es = new EventSource('/api/stream');
  es.onopen = () => { $('.live').classList.add('on'); $('#live-label').textContent = 'Live'; };
  es.onerror = () => { $('.live').classList.remove('on'); $('#live-label').textContent = 'Reconnexion…'; };
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
$('#player-sort').addEventListener('change', (e) => { state.playerSort = e.target.value; persist(); loadPlayers(); });
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
$('#player-sort').value = state.playerSort;
refreshAll();
loadFeed();
loadStatus();
setInterval(loadStatus, 30000);
connectStream();
