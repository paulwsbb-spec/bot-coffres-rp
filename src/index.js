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

if (process.argv.includes('--web-only')) {
  console.log('[bot] mode --web-only : bot Discord non démarré');
} else if (!env.token) {
  console.warn('[bot] DISCORD_TOKEN manquant dans .env — seul le dashboard est lancé');
} else {
  const { startBot } = await import('./bot.js');
  bot = await startBot({ db, cfg, env, stats, ingest });
}
