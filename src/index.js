import { loadConfig, env } from './config.js';
import { openDb, makeIngestor } from './db.js';
import { createParser } from './parser.js';
import { createStats } from './stats.js';
import { startWeb } from './web.js';

const cfg = loadConfig();
const db = openDb(env.dbPath);
const parse = createParser(cfg);
const ingest = makeIngestor(db, parse);
const stats = createStats(db);

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
