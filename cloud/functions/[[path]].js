// Relais Cloudflare Pages : https://nls-coffres.pages.dev → dashboard qui tourne sur le PC (tunnel Cloudflare).
// Le bot enregistre son lien de tunnel à chaque démarrage via POST /__register (clé secrète REGISTER_SECRET).
// Le mot de passe du dashboard reste géré par le bot (l'en-tête Authorization est transmis tel quel).

const offline = () => new Response(`<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>NLS — Coffres</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#070707;color:#f4f4f4;font:16px system-ui;text-align:center}
b{color:#d71f26}p{color:#b4b4b4}</style></head><body><div><h1>NLS <b>Coffres</b></h1>
<p>Le bot est hors ligne pour le moment.<br>Réessaie dans une minute.</p></div></body></html>`,
{ status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });

export async function onRequest({ request, env }) {
  const url = new URL(request.url);

  if (url.pathname === '/__register') {
    if (request.method !== 'POST' || request.headers.get('x-secret') !== env.REGISTER_SECRET) return new Response('forbidden', { status: 403 });
    const { target } = await request.json();
    if (!/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(target || '')) return new Response('bad target', { status: 400 });
    await env.NLS.put('target', target);
    return new Response('ok');
  }

  const target = await env.NLS.get('target');
  if (!target) return offline();

  const headers = new Headers(request.headers);
  headers.delete('host');
  let res;
  try {
    res = await fetch(target + url.pathname + url.search, {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'manual',
    });
  } catch {
    return offline();
  }
  if (res.status === 530 || res.status === 502 || res.status === 1033) return offline();
  return new Response(res.body, { status: res.status, headers: res.headers });
}
