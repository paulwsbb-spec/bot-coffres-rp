// Démo sans Discord : génère ~45 jours de faux logs (dans plusieurs formats différents,
// passés par le vrai parseur), lance le dashboard et simule des logs en temps réel.
//   npm run demo   → http://localhost:3000
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ROOT } from '../src/config.js';
import { openDb, makeIngestor, inTransaction } from '../src/db.js';
import { createParser } from '../src/parser.js';
import { createStats } from '../src/stats.js';
import { startWeb } from '../src/web.js';

const dbPath = path.join(ROOT, 'data', 'demo.db');
for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) fs.rmSync(f, { force: true });

const cfg = loadConfig();
cfg.alerts = { ...cfg.alerts, moneyWithdrawThreshold: 50000, itemWithdrawThreshold: 30 };
const db = openDb(dbPath);
const ingest = makeIngestor(db, createParser(cfg));
const stats = createStats(db);

// ---------- Données ----------
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const COFFRES = ['Flat 3 Quartier 1', 'Flat 3 Quartier 2', 'Flat 3 Quartier 3', 'Flat 3 Quartier 4'];
// Joueurs fictifs — comportement aléatoire identique pour tous (personne n'est désigné "suspect" dans la démo)
const PLAYERS = ['Alex Moreau', 'Benji Costa', 'Carlos Vega', 'Diego Ramos', 'Enzo Ricci', 'Farid Nasri', 'Gino Russo', 'Hugo Lambert'].map((n, k) => [n, k + 1]);
// Items du serveur (orthographe du jeu, ex. "crochettage")
const ITEMS = [['Outil de crochettage', 6], ['Outil de crochettage', 6], ['Boîtier de piratage', 3], ['Boîtier de piratage', 3],
  ['Cocaïne', 15], ['Cannabis', 20], ['Pochon De Mexicana', 15], ['Munition de pistolet', 60], ['Pistolet SNS (W6WEHSLTWU)', 1],
  ['Ecstasy', 10], ['Disqueuse', 1], ['Boîtier Darknet', 1], ['Menu boeuf', 8], ['Bandage', 10]];

function fakeTx(t) {
  const [player, id, role] = pick(PLAYERS);
  const coffre = pick(COFFRES);
  const withdraw = rnd() < (role === 'taker' ? 0.78 : 0.42);
  const money = rnd() < 0.3;
  const dirty = money && rnd() < 0.4;
  const amount = Math.round((rnd() ** 2 * (role === 'taker' ? 180000 : 60000) + 500) / 100) * 100;
  const [item, maxQ] = pick(ITEMS);
  const qty = Math.max(1, Math.round(rnd() * maxQ));
  const fmtAmount = amount.toLocaleString('fr-FR').replace(/ /g, ' ');
  // 3 fois sur 4 : format exact du serveur NLS (titre = coffre, "**Joueur** a déposé 12x Item")
  if (rnd() < 0.75) {
    return { ts: t, embeds: [{ title: coffre, description: `**${player}** a ${withdraw ? 'retiré' : 'déposé'} ${money ? `${amount}x Argent Sale` : `${qty}x ${item}`}`, fields: [] }] };
  }
  // sinon d'autres formats, pour prouver le parseur
  switch (Math.floor(rnd() * 4)) {
    case 0: return { ts: t, embeds: [{ title: `Coffre - ${withdraw ? 'Retrait' : 'Dépôt'}`, fields: [
      { name: 'Joueur', value: `${player} (ID ${id})` }, { name: 'Coffre', value: coffre },
      money ? { name: 'Objet', value: dirty ? 'Argent sale' : 'Argent' } : { name: 'Objet', value: item },
      { name: 'Quantité', value: money ? String(amount) : String(qty) }] }] };
    case 1: return { ts: t, content: money
      ? `${player} a ${withdraw ? 'retiré' : 'déposé'} ${fmtAmount}$${dirty ? " d'argent sale" : ''} ${withdraw ? 'du' : 'dans le'} coffre ${coffre}`
      : `${player} a ${withdraw ? 'retiré' : 'déposé'} ${qty}x ${item} ${withdraw ? 'du' : 'dans le'} coffre ${coffre}` };
    case 2: return { ts: t, embeds: [{ description: money
      ? `${player} [${id}] ${withdraw ? 'withdrew' : 'deposited'} $${amount.toLocaleString('en-US')}${dirty ? ' black money' : ''} ${withdraw ? 'from' : 'into'} stash ${coffre}`
      : `${player} [${id}] ${withdraw ? 'took' : 'put'} ${qty}x ${item} ${withdraw ? 'from' : 'into'} stash ${coffre}` }] };
    default: return { ts: t, embeds: [{ title: withdraw ? '📤 Retrait' : '📥 Dépôt',
      description: `**Joueur:** ${player}\n**Coffre:** ${coffre}\n` + (money ? `**Montant:** ${fmtAmount}$${dirty ? '\n**Type:** argent sale' : ''}` : `**Item:** ${item}\n**Quantité:** ${qty}`) }] };
  }
}

let n = 0;
const now = Date.now();
inTransaction(db, () => {
  for (let day = 21; day >= 0; day--) {
    const count = 25 + Math.floor(rnd() * 35);
    for (let k = 0; k < count; k++) {
      const hour = rnd() < 0.75 ? 18 + Math.floor(rnd() * 7) : Math.floor(rnd() * 24);
      const t = now - day * 86400e3 - ((24 - hour) % 24) * 3600e3 - Math.floor(rnd() * 3600e3);
      if (t > now) continue;
      ingest({ id: `demo-${n++}`, channelId: 'demo', ...fakeTx(t) }, { emit: false });
    }
  }
  // quelques logs que le parseur ne comprend pas (pour la section "non reconnus")
  for (const c of ['Serveur redémarré', 'Inventaire synchronisé (12 slots)', 'Erreur webhook 429']) {
    ingest({ id: `demo-${n++}`, channelId: 'demo', ts: now - rnd() * 86400e3 * 5, content: c, embeds: [] }, { emit: false });
  }
});
const s = stats.summary({});
console.log(`[demo] ${n} faux logs → ${s.n} mouvements, ${s.unparsed} non reconnus`);

const portArg = process.argv.indexOf('--port');
const port = Number(portArg > 0 ? process.argv[portArg + 1] : process.env.DASHBOARD_PORT || 3000);
startWeb({ stats, cfg, env: { port, password: '' }, getStatus: () => ({ bot: 'DÉMO', backfilling: false, channels: 0 }) });

// Temps réel simulé
setInterval(() => ingest({ id: `demo-${n++}`, channelId: 'demo', ...fakeTx(Date.now()) }), 3500);
