// Connexion au dashboard : page /login + cookie de session signé (HMAC du mot de passe).
const PUBLIC = new Set(['/login', '/login.html', '/bot-logo.png', '/api/login', '/interactions']);
const enc = new TextEncoder();
const attempts = new Map();

async function token(password) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode('nls-coffres-session'));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function safeEq(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const cookie = (req, name) => (req.headers.get('cookie') || '').split(';').map((c) => c.trim().split('=')).find(([k]) => k === name)?.[1] || '';
const json = (o, status = 200, headers = {}) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...headers } });

export async function onRequest({ request, env, next }) {
  const url = new URL(request.url);
  const pw = env.DASHBOARD_PASSWORD || '';

  if (url.pathname === '/api/login' && request.method === 'POST') {
    const ip = request.headers.get('cf-connecting-ip') || '?';
    const now = Date.now();
    const a = attempts.get(ip) || { n: 0, t: now };
    if (now - a.t > 10 * 60e3) { a.n = 0; a.t = now; }
    if (a.n >= 8) return json({ error: 'Trop d\'essais. Réessaie dans quelques minutes.' }, 429);
    const { password = '' } = await request.json().catch(() => ({}));
    if (!pw || !safeEq(String(password), pw)) { a.n++; attempts.set(ip, a); return json({ error: 'Mot de passe incorrect' }, 401); }
    attempts.delete(ip);
    return json({ ok: true }, 200, { 'Set-Cookie': `nls_session=${await token(pw)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 86400}` });
  }
  if (url.pathname === '/logout') {
    return new Response(null, { status: 302, headers: { Location: '/login', 'Set-Cookie': 'nls_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0' } });
  }

  const ok = pw && safeEq(cookie(request, 'nls_session'), await token(pw));
  if (ok && (url.pathname === '/login' || url.pathname === '/login.html')) return new Response(null, { status: 302, headers: { Location: '/' } });
  if (!ok && !PUBLIC.has(url.pathname)) {
    if (url.pathname.startsWith('/api/')) return json({ error: 'non connecté' }, 401);
    return new Response(null, { status: 302, headers: { Location: '/login' } });
  }
  return next();
}
