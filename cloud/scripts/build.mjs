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

// Module opérations : noms de salons → IDs
if (cfg.ops?.channels) {
  const chans = await (await fetch(`https://discord.com/api/v10/guilds/${env.GUILD_ID}/channels`,
    { headers: { Authorization: `Bot ${env.DISCORD_TOKEN}` } })).json();
  cfg.ops.channelIds = {};
  for (const [k, name] of Object.entries(cfg.ops.channels)) {
    const c = chans.find((x) => x.name === name || x.id === name);
    if (c) cfg.ops.channelIds[k] = c.id;
    else console.warn(`⚠ salon "${name}" introuvable`);
  }
}

fs.mkdirSync(path.join(root, 'cloud', 'generated'), { recursive: true });
fs.writeFileSync(path.join(root, 'cloud', 'generated', 'config.json'), JSON.stringify(cfg, null, 2));

const pub = path.join(root, 'cloud', 'public');
fs.mkdirSync(pub, { recursive: true });
for (const f of fs.readdirSync(path.join(root, 'web'))) fs.copyFileSync(path.join(root, 'web', f), path.join(pub, f));
console.log(`config : ${Object.keys(cfg.channels).length} salons · dashboard copié (${fs.readdirSync(pub).length} fichiers)`);
