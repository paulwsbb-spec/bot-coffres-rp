// Envoie les secrets (token du bot, clé publique Discord, mot de passe du dashboard) à Cloudflare
// sans jamais les afficher. Usage : node cloud/scripts/set-secrets.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const env = Object.fromEntries(fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)
  .filter((l) => /^\w+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const h = { Authorization: `Bot ${env.DISCORD_TOKEN}` };
const app = await (await fetch('https://discord.com/api/v10/applications/@me', { headers: h })).json();
const me = await (await fetch('https://discord.com/api/v10/users/@me', { headers: h })).json();
if (!app.verify_key || !me.id) throw new Error('Impossible de lire l\'application Discord (token ?)');

const ACC = { ...process.env, CLOUDFLARE_ACCOUNT_ID: '211cdc9ce1668599672c1a688dec1eae' };
const put = (name, value, args, cwd) => {
  const r = spawnSync('npx', ['-y', 'wrangler@4', ...args, 'secret', 'put', name, ...(args[0] === 'pages' ? ['--project-name', 'nls-coffres'] : [])],
    { cwd, input: value, env: ACC, shell: true, encoding: 'utf8' });
  console.log(`${args[0] === 'pages' ? 'site' : 'bot '} · ${name} : ${r.status === 0 ? 'ok' : 'ERREUR ' + (r.stderr || r.stdout).slice(-200)}`);
};
const worker = path.join(root, 'cloud', 'worker');
const pages = path.join(root, 'cloud');
put('DISCORD_TOKEN', env.DISCORD_TOKEN, [], worker);
put('BOT_ID', me.id, [], worker);
put('DISCORD_TOKEN', env.DISCORD_TOKEN, ['pages'], pages);
put('DISCORD_PUBLIC_KEY', app.verify_key, ['pages'], pages);
put('BOT_ID', me.id, ['pages'], pages);
put('DASHBOARD_PASSWORD', env.DASHBOARD_PASSWORD, ['pages'], pages);
