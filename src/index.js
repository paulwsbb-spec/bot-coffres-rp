import { loadConfig, env } from './config.js';
import { openDb, makeIngestor, reparseAll } from './db.js';
import { createParser, PARSER_VERSION } from './parser.js';
import { createStats } from './stats.js';
import { startWeb } from './web.js';

const cfg = loadConfig();
const db = openDb(env.dbPath);
const parse = createParser(cfg);
const ingest = makeIngestor(db, parse);
const stats = createStats(db);

// Parseur mis à jour depuis le dernier lancement → ré-analyse les logs déjà stockés
db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
const fingerprint = `${PARSER_VERSION}:${JSON.stringify(cfg.rules || [])}:${JSON.stringify(cfg.itemAliases || {})}:${JSON.stringify(cfg.coffreAliases || {})}`;
const prev = db.prepare("SELECT value FROM meta WHERE key = 'parser'").get()?.value;
if (prev !== fingerprint) {
  const hasData = db.prepare('SELECT 1 FROM transactions UNION ALL SELECT 1 FROM unparsed LIMIT 1').get();
  if (hasData) {
    const r = reparseAll(db, ingest, (id) => cfg.channels[id]?.coffre || null);
    console.log(`[parseur] mis à jour → ré-analyse : ${r.messages} messages, ${r.transactions} mouvements, ${r.unparsed} non reconnus`);
  }
  db.prepare("INSERT INTO meta (key, value) VALUES ('parser', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(fingerprint);
}

let bot = null;
startWeb({
  stats, cfg, env,
  getStatus: () => ({
    bot: bot?.client?.isReady() ? bot.client.user.tag : null,
    backfilling: bot?.backfillState?.running || false,
    channels: Object.keys(cfg.channels || {}).length,
  }),
});

// Lien public (tunnel Cloudflare) : PUBLIC_TUNNEL=1 dans .env
if (process.env.PUBLIC_TUNNEL === '1') {
  if (!env.password) {
    console.warn('[tunnel] DASHBOARD_PASSWORD vide dans .env : lien public NON lancé (tout le monde verrait tes stats)');
  } else {
    const { startTunnel } = await import('./tunnel.js');
    startTunnel({
      port: env.port,
      onUrl: (url) => {
        env.dashboardUrl = url;
        console.log('\n==============================================================');
        console.log(`  DASHBOARD EN LIGNE : ${url}`);
        console.log('  (mot de passe = DASHBOARD_PASSWORD du fichier .env, identifiant : n\'importe lequel)');
        console.log('==============================================================\n');
      },
    });
  }
}

if (process.argv.includes('--web-only')) {
  console.log('[bot] mode --web-only : bot Discord non démarré');
} else if (!env.token) {
  console.warn('[bot] DISCORD_TOKEN manquant dans .env — seul le dashboard est lancé');
} else {
  const { startBot } = await import('./bot.js');
  bot = await startBot({ db, cfg, env, stats, ingest });
}
