// Assistant d'installation : vérifie le token, génère le lien d'invitation, choisit le serveur
// et le salon de logs, détecte les salons des coffres, vérifie les accès, écrit .env et config.json.
//   npm run setup
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { ROOT } from '../src/config.js';

const API = 'https://discord.com/api/v10';
const PERMS = 1024 + 2048 + 8192 + 16384 + 65536; // Voir, Envoyer, Gérer les messages (épingler), Liens intégrés, Lire l'historique
const C = { g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m` };
const rl = readline.createInterface({ input: stdin, output: stdout });
const ask = async (q, def = '') => (await rl.question(`${q}${def ? C.d(` [${def}]`) : ''} : `)).trim() || def;
const slugify = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const envFile = path.join(ROOT, '.env');
const cfgFile = path.join(ROOT, 'config.json');
const readEnv = () => Object.fromEntries((fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '').split(/\r?\n/)
  .filter((l) => /^\w+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const env = readEnv();

let token = env.DISCORD_TOKEN || '';
const api = async (p) => {
  const r = await fetch(API + p, { headers: { Authorization: `Bot ${token}` } });
  return { ok: r.ok, status: r.status, data: await r.json().catch(() => null) };
};

console.log(C.b('\n=== Installation du bot Coffres RP ===\n'));

// 1. Token
for (;;) {
  if (!token) {
    console.log('Récupère le token : https://discord.com/developers/applications → ton appli → Bot → Reset Token');
    token = await ask('Colle le token du bot ici (il reste sur ton PC)');
  }
  const me = await api('/users/@me');
  if (me.ok) { console.log(C.g(`✔ Token valide : ${me.data.username}`)); break; }
  console.log(C.r(`✘ Token refusé (${me.status}). Réessaie.`));
  token = '';
}

// 2. Intent "Message Content"
const app = await api('/oauth2/applications/@me');
const appId = app.data?.id;
const flags = app.data?.flags || 0;
if (flags & ((1 << 18) | (1 << 19))) console.log(C.g('✔ Intent "Message Content" activé'));
else {
  console.log(C.y('⚠ Intent "Message Content" PAS activé → le bot ne pourra pas lire les logs.'));
  console.log(`  Active-le ici : https://discord.com/developers/applications/${appId}/bot  (section Privileged Gateway Intents)`);
  await ask('Appuie sur Entrée une fois activé');
}

// 3. Invitation
const invite = `https://discord.com/oauth2/authorize?client_id=${appId}&permissions=${PERMS}&scope=bot%20applications.commands`;
let guilds = (await api('/users/@me/guilds')).data || [];
if (!guilds.length) {
  console.log(`\n${C.b('Invite le bot sur ton serveur')} avec ce lien :\n${C.y(invite)}\n`);
  await ask('Appuie sur Entrée une fois le bot ajouté');
  guilds = (await api('/users/@me/guilds')).data || [];
}
if (!guilds.length) { console.log(C.r('Le bot n\'est sur aucun serveur. Relance `npm run setup` après l\'avoir invité.')); process.exit(1); }

let guild = guilds[0];
if (guilds.length > 1) {
  guilds.forEach((g, k) => console.log(`  ${k + 1}. ${g.name}`));
  guild = guilds[Number(await ask('Numéro du serveur', '1')) - 1] || guilds[0];
}
console.log(C.g(`✔ Serveur : ${guild.name}`));

// 4. Salons
const chans = ((await api(`/guilds/${guild.id}/channels`)).data || []).filter((c) => [0, 5].includes(c.type)).sort((a, b) => a.position - b.position);
const cats = Object.fromEntries(((await api(`/guilds/${guild.id}/channels`)).data || []).filter((c) => c.type === 4).map((c) => [c.id, c.name]));
console.log(`\n${C.b('Salons texte du serveur :')}`);
chans.forEach((c, k) => console.log(`  ${String(k + 1).padStart(3)}. #${c.name} ${C.d(cats[c.parent_id] ? `(${cats[c.parent_id]})` : '')}`));

const pickChannel = async (q, optional = false) => {
  for (;;) {
    const v = await ask(q, optional ? 'aucun' : '');
    if (optional && (v === 'aucun' || !v)) return null;
    const c = chans[Number(v) - 1] || chans.find((x) => x.name === v.replace(/^#/, '') || x.id === v);
    if (c) return c;
    console.log(C.r('  Numéro ou nom invalide.'));
  }
};
const logCh = await pickChannel('\nNuméro du salon où arrivent les LOGS du webhook');
const alertCh = await pickChannel('Numéro du salon pour les ALERTES gros retraits (Entrée = aucun)', true);

// 5. Salons des coffres
const looksLikeCoffre = chans.filter((c) => c.id !== logCh.id && /^flat-|coffre|stash/i.test(c.name));
console.log(`\n${C.b('Salons de coffres détectés')} ${C.d('(les mouvements y seront rangés selon le nom du coffre dans le log)')}`);
looksLikeCoffre.forEach((c) => console.log(`  • #${c.name}`));
const extra = await ask('Autres salons de coffres ? (numéros séparés par des virgules, Entrée = non)', '');
const coffreChans = [...looksLikeCoffre, ...extra.split(',').map((x) => chans[Number(x.trim()) - 1]).filter(Boolean)];

// 6. Vérifie les accès (salons privés : le rôle du bot doit y être ajouté)
console.log(`\n${C.b('Vérification des accès…')}`);
let missing = 0;
for (const c of [logCh, alertCh, ...coffreChans].filter(Boolean)) {
  const r = await api(`/channels/${c.id}/messages?limit=1`);
  if (r.ok) console.log(C.g(`  ✔ #${c.name}`));
  else { missing++; console.log(C.r(`  ✘ #${c.name} : pas d'accès (${r.status})`)); }
}
if (missing) {
  console.log(C.y(`\n  Tes salons sont privés 🔒 : pour chacun en rouge → Modifier le salon → Permissions → Ajouter le rôle du bot
  avec : Voir le salon, Envoyer des messages, Intégrer des liens, Lire l'historique, Gérer les messages.`));
  console.log(C.d('  (Ou plus simple : mets ces permissions sur la catégorie qui contient les salons.)'));
}

// 7. Écrit la config
const cfg = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, 'utf8')) : {};
cfg.channels = { [logCh.id]: { coffre: null, label: logCh.name } };
cfg.alertChannelId = alertCh?.id || '';
cfg.autoRoute = true;
cfg.routing = Object.fromEntries(coffreChans.map((c) => [c.name, c.id]));
fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n');

const port = env.DASHBOARD_PORT || '3000';
const newEnv = {
  DISCORD_TOKEN: token,
  GUILD_ID: guild.id,
  DASHBOARD_PORT: port,
  DASHBOARD_PASSWORD: env.DASHBOARD_PASSWORD || '',
  DASHBOARD_URL: env.DASHBOARD_URL || `http://localhost:${port}`,
  DB_PATH: env.DB_PATH || './data/coffres.db',
};
fs.writeFileSync(envFile, Object.entries(newEnv).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');

console.log(C.g(`\n✔ Configuration enregistrée (.env + config.json)`));
console.log(`  Logs lus dans   : #${logCh.name}`);
console.log(`  Rangés dans     : ${coffreChans.map((c) => '#' + c.name).join(', ') || '—'}`);
console.log(`  Alertes         : ${alertCh ? '#' + alertCh.name : 'désactivées'}`);
console.log(`\n${C.b('Lance le bot')} : tape ${C.y('npm start')} dans cette fenêtre (et laisse-la ouverte)`);
console.log(`Puis dans Discord : ${C.y('/salons')} pour vérifier, ${C.y('/classer')} pour ranger l'historique.\n`);
rl.close();
