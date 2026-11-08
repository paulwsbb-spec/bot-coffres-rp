// Importe d'anciens logs depuis un fichier, sans passer par le bot.
//
//   npm run import -- chemin/export.json [--coffre "Nom"] [--channel 123456]
//   npm run import -- chemin/logs.txt   [--coffre "Nom"]
//   npm run import -- --reparse          (ré-analyse ce qui est déjà en base avec les règles actuelles)
//
// Formats acceptés :
//   • .json  : export DiscordChatExporter (https://github.com/Tyrrrz/DiscordChatExporter), format "JSON"
//   • .txt / .log / .csv : une ligne = un log ; date optionnelle en début de ligne
//       [08/11/2026 14:32] Jean a déposé 5x Pain dans le coffre Vagos
//       2026-11-08 14:32:10 | John withdrew 3x WEAPON_PISTOL from stash police
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadConfig, env } from '../src/config.js';
import { openDb, makeIngestor, inTransaction, reparseAll } from '../src/db.js';
import { createParser } from '../src/parser.js';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
const cfg = loadConfig();
const db = openDb(env.dbPath);
const ingest = makeIngestor(db, createParser(cfg));

if (args.includes('--reparse')) {
  const r = reparseAll(db, ingest, (id) => cfg.channels[id]?.coffre || null);
  console.log(`Ré-analyse : ${r.messages} messages → ${r.transactions} mouvements, ${r.unparsed} non reconnus`);
  process.exit(0);
}

const file = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
if (!file || !fs.existsSync(file)) {
  console.error('Usage : npm run import -- <fichier.json|.txt> [--coffre "Nom"] [--channel ID]');
  process.exit(1);
}

const coffreOverride = opt('coffre');
let total = 0, txCount = 0;

function parseDate(s) {
  let m;
  if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(s))) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return new Date(y, m[2] - 1, m[1], m[4], m[5], m[6] || 0).getTime();
  }
  if ((m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s))) return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}`).getTime();
  return null;
}

if (path.extname(file).toLowerCase() === '.json') {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const channelId = opt('channel') || data.channel?.id || null;
  const defaultCoffre = coffreOverride || cfg.channels[channelId]?.coffre || null;
  inTransaction(db, () => {
    for (const m of data.messages || []) {
      total++;
      txCount += ingest({
        id: m.id,
        channelId,
        ts: new Date(m.timestamp).getTime(),
        content: m.content || '',
        embeds: (m.embeds || []).map((e) => ({
          title: e.title, description: e.description, author: e.author?.name, footer: e.footer?.text,
          fields: (e.fields || []).map((f) => ({ name: f.name, value: f.value })),
        })),
      }, { defaultCoffre, emit: false }).length;
    }
  });
} else {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim());
  const base = Date.now() - lines.length * 1000;
  inTransaction(db, () => {
    lines.forEach((line, k) => {
      total++;
      const stripped = line.replace(/^\s*\[([^\]]+)\]\s*/, '$1 | ');
      const date = parseDate(stripped);
      const content = date ? stripped.replace(/^[^|]*?\d{1,2}:\d{2}(:\d{2})?\s*[|\-–]?\s*/, '') : line;
      const id = 'file-' + crypto.createHash('sha1').update(`${path.basename(file)}:${k}:${line}`).digest('hex').slice(0, 16);
      txCount += ingest({ id, channelId: opt('channel'), ts: date || base + k * 1000, content, embeds: [] },
        { defaultCoffre: coffreOverride, emit: false }).length;
    });
  });
}

const unparsed = db.prepare('SELECT COUNT(*) AS n FROM unparsed').get().n;
console.log(`Import terminé : ${total} logs lus → ${txCount} nouveaux mouvements. Non reconnus en base : ${unparsed}`);
