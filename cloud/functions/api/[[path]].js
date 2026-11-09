// API du dashboard (Cloudflare Pages Functions + D1). Mêmes routes que src/web.js (version PC).
import { createStats, periodToRange, weekStart, weekEnd } from '../../shared/cstats.js';
import CONFIG from '../../generated/config.json';

const KEY_ITEMS = CONFIG.kpiItems || ['Outil de crochetage', 'Boîtier de piratage'];
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

function filtersFrom(q) {
  const f = {
    coffre: q.get('coffre') || null,
    player: q.get('player') || null,
    item: q.get('item') || null,
    action: ['deposit', 'withdraw'].includes(q.get('action')) ? q.get('action') : null,
    kind: ['money', 'item'].includes(q.get('kind')) ? q.get('kind') : null,
    q: q.get('q') || null,
    ...periodToRange(q.get('period')),
  };
  if (q.get('from')) f.from = Number(q.get('from'));
  if (q.get('to')) f.to = Number(q.get('to'));
  return f;
}

export async function onRequest({ request, env, params }) {
  const url = new URL(request.url);
  const q = url.searchParams;
  const path = '/' + [].concat(params.path || []).join('/');
  const s = createStats(env.DB);
  const f = filtersFrom(q);
  const week = Number(q.get('week')) || weekStart();

  const routes = {
    '/coffres': () => s.coffres(),
    '/summary': () => s.summary(f),
    '/timeline': () => s.timeline(f),
    '/players': () => s.players(f, { sort: q.get('sort') || 'activity', limit: q.get('limit') || 50 }),
    '/weeks': () => s.weeks({ coffre: f.coffre }),
    '/ranking': async () => ({ start: week, next_reset: weekEnd(weekStart()), rows: await s.ranking(week, { coffre: f.coffre }) }),
    '/key-items': () => {
      const wk = Number(q.get('week'));
      const g = wk ? { ...f, from: wk, to: weekEnd(wk) - 1 } : f;
      return Promise.all(KEY_ITEMS.map((it) => s.itemDetail({ ...g, item: null }, it)));
    },
    '/week-report': () => s.weekReport(week, { coffre: f.coffre }, KEY_ITEMS),
    '/items': () => s.items(f, { limit: q.get('limit') || 100 }),
    '/stock': () => s.stock(f),
    '/heatmap': () => s.heatmap(f),
    '/transactions': () => s.transactions(f, { limit: q.get('limit') || 50, offset: q.get('offset') || 0 }),
    '/alerts': () => s.alerts(f, CONFIG),
    '/unparsed': () => s.unparsed({ limit: q.get('limit') || 50 }),
    '/status': () => ({ bot: 'en ligne 24h/24 (Cloudflare)', backfilling: false, cloud: true, alerts: CONFIG.alerts }),
  };
  if (path === '/stream') return new Response(null, { status: 204 }); // pas de flux continu : le dashboard rafraîchit tout seul
  const route = routes[path];
  if (!route) return json({ error: 'not found' }, 404);
  try { return json(await route()); }
  catch (e) { return json({ error: e.message }, 500); }
}
