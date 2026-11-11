// Importe tout l'historique de salons Discord dans la base D1 (sans passer par le PC bot).
//   node --env-file=.env cloud/scripts/backfill.mjs <id_salon> [<id_salon>...]  > cloud/generated/backfill.sql
// Écrit aussi un résumé sur stderr.
import { createParser } from '../../src/parser.js';
import { loadConfig } from '../../src/config.js';

const cfg = loadConfig();
const parse = createParser(cfg);
const h = { Authorization: `Bot ${process.env.DISCORD_TOKEN}` };
const me = await (await fetch('https://discord.com/api/v10/users/@me', { headers: h })).json();
const q = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const channelId of process.argv.slice(2)) {
  const all = [];
  let before = '';
  for (;;) {
    const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages?limit=100${before ? `&before=${before}` : ''}`, { headers: h });
    if (r.status === 429) { await sleep(((await r.json()).retry_after || 1) * 1000); continue; }
    const batch = await r.json();
    if (!Array.isArray(batch) || !batch.length) break;
    all.push(...batch);
    before = batch.at(-1).id;
    if (batch.length < 100) break;
  }
  all.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  let tx = 0; let un = 0; const coffres = new Map();
  for (const m of all) {
    if (!(m.webhook_id || (m.author?.bot && m.author.id !== me.id))) continue;
    const plain = { id: m.id, channelId, ts: Date.parse(m.timestamp), content: m.content || '',
      embeds: (m.embeds || []).map((e) => ({ title: e.title, description: e.description, author: e.author?.name, footer: e.footer?.text,
        fields: (e.fields || []).map((f) => ({ name: f.name, value: f.value })) })) };
    const txs = parse(plain, { defaultCoffre: cfg.channels[channelId]?.coffre || null });
    const raw = JSON.stringify({ content: plain.content || undefined, embeds: plain.embeds.length ? plain.embeds : undefined });
    if (!txs.length) { un++; console.log(`INSERT OR IGNORE INTO unparsed (message_id,channel_id,ts,raw) VALUES (${q(m.id)},${q(channelId)},${plain.ts},${q(raw)});`); continue; }
    txs.forEach((x, i) => {
      tx++; coffres.set(x.coffre, (coffres.get(x.coffre) || 0) + 1);
      console.log(`INSERT OR IGNORE INTO transactions (message_id,idx,channel_id,ts,coffre,player,player_id,action,kind,item,quantity,amount,raw) VALUES (${[m.id, i, channelId, plain.ts, x.coffre, x.player, x.player_id, x.action, x.kind, x.item, x.quantity, x.amount, i === 0 ? raw : null].map(q).join(',')});`);
    });
  }
  if (all.length) console.log(`INSERT INTO cursors (channel_id,newest_id) VALUES (${q(channelId)},${q(all.at(-1).id)}) ON CONFLICT(channel_id) DO UPDATE SET newest_id = excluded.newest_id;`);
  console.error(`${cfg.channels[channelId]?.label || channelId} : ${all.length} messages → ${tx} mouvements, ${un} non reconnus · coffres : ${[...coffres].map(([c, n]) => `${c} (${n})`).join(', ') || '—'}`);
}
