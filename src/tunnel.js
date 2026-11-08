// Lien public du dashboard via un tunnel Cloudflare gratuit (sans compte).
// Le lien change à chaque redémarrage : il est affiché dans la console, écrit dans
// data/lien-dashboard.txt et renvoyé par /dashboard.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

export function findCloudflared() {
  const local = path.join(ROOT, 'tools', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  return fs.existsSync(local) ? local : 'cloudflared';
}

export function startTunnel({ port, onUrl }) {
  const bin = findCloudflared();
  const child = spawn(bin, ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate'], { windowsHide: true });
  let found = false;
  const scan = (buf) => {
    const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(String(buf));
    if (m && !found) {
      found = true;
      fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
      fs.writeFileSync(path.join(ROOT, 'data', 'lien-dashboard.txt'), m[0] + '\n');
      onUrl(m[0]);
    }
  };
  child.stdout.on('data', scan);
  child.stderr.on('data', scan);
  child.on('error', (e) => console.error(`[tunnel] impossible de lancer cloudflared (${e.message}) — dashboard seulement en local`));
  child.on('exit', (code) => { if (code) console.warn(`[tunnel] arrêté (code ${code})`); });
  const stop = () => { try { child.kill(); } catch { /* déjà arrêté */ } };
  process.on('exit', stop);
  process.on('SIGINT', () => { stop(); process.exit(0); });
  return child;
}
