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

  // ---------- Connexion : page de login + cookie de session ----------
  // Jeton = HMAC du mot de passe : reste valable après un redémarrage, invalidé si le mot de passe change.
  const sessionToken = () => crypto.createHmac('sha256', env.password).update('nls-coffres-session').digest('hex');
  const safeEq = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
  const authorized = (req) => !env.password || safeEq(cookies(req).nls_session || '', sessionToken());
  const PUBLIC_PATHS = new Set(['/login', '/login.html', '/login.css', '/bot-logo.png', '/api/login']);
  const attempts = new Map(); // anti brute-force : 8 essais / 10 min par IP
  const clientIp = (req) => req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;

  function readBody(req) {
    return new Promise((resolve) => {
      let data = '';
      req.on('data', (c) => { data += c; if (data.length > 1e4) req.destroy(); });
      req.on('end', () => resolve(data));
    });
  }

  async function handleLogin(req, res) {
    const ip = clientIp(req);
    const now = Date.now();
    const a = attempts.get(ip) || { n: 0, t: now };
    if (now - a.t > 10 * 60e3) { a.n = 0; a.t = now; }
    if (a.n >= 8) return send(res, 429, { error: 'Trop d\'essais. Réessaie dans quelques minutes.' });
    let password = '';
    try { password = JSON.parse(await readBody(req) || '{}').password || ''; } catch { /* corps invalide */ }
    if (!env.password || !safeEq(password, env.password)) {
      a.n++; attempts.set(ip, a);
      return send(res, 401, { error: 'Mot de passe incorrect' });
    }
    attempts.delete(ip);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': `nls_session=${sessionToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}`,
    });
    res.end('{"ok":true}');
  }

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
    const url = new URL(req.url, 'http://x');

    if (url.pathname === '/api/login' && req.method === 'POST') return handleLogin(req, res);
    if (url.pathname === '/logout') {
      res.writeHead(302, { Location: '/login', 'Set-Cookie': 'nls_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' });
      return res.end();
    }
    if (url.pathname === '/login') url.pathname = '/login.html';
    if (!authorized(req) && !PUBLIC_PATHS.has(url.pathname)) {
      if (url.pathname.startsWith('/api/')) return send(res, 401, { error: 'non connecté' });
      res.writeHead(302, { Location: '/login' });
      return res.end();
    }
    if (url.pathname === '/login.html' && authorized(req) && env.password) {
      res.writeHead(302, { Location: '/' });
      return res.end();
    }

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
