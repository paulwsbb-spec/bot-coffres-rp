import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { bus } from './db.js';
import { ROOT } from './config.js';
import { periodToRange } from './stats.js';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png' };
const WEB_DIR = path.join(ROOT, 'web');

export function startWeb({ stats, cfg, env, getStatus = () => ({}) }) {
  const sseClients = new Set();
  const send = (res, code, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };

  const authorized = (req) => {
    if (!env.password) return true;
    const h = req.headers.authorization || '';
    if (!h.startsWith('Basic ')) return false;
    const pass = Buffer.from(h.slice(6), 'base64').toString().split(':').slice(1).join(':');
    const a = Buffer.from(pass);
    const b = Buffer.from(env.password);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  const filtersFrom = (q) => {
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
  };

  const routes = {
    '/api/coffres': () => stats.coffres(),
    '/api/summary': (f) => stats.summary(f),
    '/api/timeline': (f) => stats.timeline(f),
    '/api/players': (f, q) => stats.players(f, { sort: q.get('sort') || 'activity', limit: q.get('limit') || 50 }),
    '/api/items': (f, q) => stats.items(f, { limit: q.get('limit') || 100 }),
    '/api/stock': (f) => stats.stock(f),
    '/api/heatmap': (f) => stats.heatmap(f),
    '/api/transactions': (f, q) => stats.transactions(f, { limit: q.get('limit') || 50, offset: q.get('offset') || 0 }),
    '/api/alerts': (f) => stats.alerts(f, cfg),
    '/api/unparsed': (f, q) => stats.unparsed({ limit: q.get('limit') || 50 }),
    '/api/status': () => ({ ...getStatus(), alerts: cfg.alerts }),
  };

  const server = http.createServer((req, res) => {
    if (!authorized(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Coffres RP"' });
      return res.end('Authentification requise');
    }
    const url = new URL(req.url, 'http://x');

    if (url.pathname === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('retry: 3000\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    const route = routes[url.pathname];
    if (route) {
      try { return send(res, 200, route(filtersFrom(url.searchParams), url.searchParams)); }
      catch (e) { console.error('[web]', e); return send(res, 500, { error: e.message }); }
    }

    // Fichiers statiques
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.resolve(WEB_DIR, rel);
    if (!file.startsWith(WEB_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'Not found', 'text/plain');
    send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
  });

  const broadcast = (event, data) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of sseClients) c.write(payload);
  };
  bus.on('tx', (txs) => broadcast('tx', txs));
  bus.on('refresh', () => broadcast('refresh', {}));
  setInterval(() => broadcast('ping', Date.now()), 25000).unref();

  server.listen(env.port, () => console.log(`[web] dashboard sur http://localhost:${env.port}${env.password ? ' (protégé par mot de passe)' : ''}`));
  return server;
}
