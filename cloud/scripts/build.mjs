// Prépare le déploiement Cloudflare :
//   • cloud/generated/config.json  ← config.json du PC + ID du serveur + lien du dashboard (non publié sur GitHub)
//   • cloud/public/                ← copie du dashboard (web/)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const env = Object.fromEntries(fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)
  .filter((l) => /^\w+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
cfg.guildId = env.GUILD_ID;
cfg.dashboardUrl = 'https://nls-coffres.pages.dev';

fs.mkdirSync(path.join(root, 'cloud', 'generated'), { recursive: true });
fs.writeFileSync(path.join(root, 'cloud', 'generated', 'config.json'), JSON.stringify(cfg, null, 2));

const pub = path.join(root, 'cloud', 'public');
fs.mkdirSync(pub, { recursive: true });
for (const f of fs.readdirSync(path.join(root, 'web'))) fs.copyFileSync(path.join(root, 'web', f), path.join(pub, f));
console.log(`config : ${Object.keys(cfg.channels).length} salons · dashboard copié (${fs.readdirSync(pub).length} fichiers)`);
