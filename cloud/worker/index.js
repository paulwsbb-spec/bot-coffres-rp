// Bot NLS Coffres — version Cloudflare 24/7 (Worker, sans PC).
//  • Toutes les minutes (cron) : lit les nouveaux logs des salons, les enregistre dans D1, met à jour les panneaux.
//  • POST /interactions : commandes slash Discord (/stats, /classement, /solde…).
import { createParser } from '../../src/parser.js';
import { createStats, periodToRange, weekStart, weekEnd } from '../shared/cstats.js';
import CONFIG from '../generated/config.json';
import { COMMANDS } from './commands.js';

const API = 'https://discord.com/api/v10';
const nf = new Intl.NumberFormat('fr-FR');
const $ = (n) => `${nf.format(Math.round(n || 0))} $`;
const signed = (n) => `${n >= 0 ? '+' : '−'}${$(Math.abs(n))}`;
const t = (ms, s = 'R') => `<t:${Math.floor(ms / 1000)}:${s}>`;
const RED = 0xd71f26;

async function dc(env, path, { method = 'GET', body } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(API + path, {
      method,
      headers: { Authorization: `Bot ${env.DISCORD_TOKEN}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 429) { const j = await r.json().catch(() => ({})); await new Promise((res) => setTimeout(res, Math.min(5000, (j.retry_after || 1) * 1000))); continue; }
    if (r.status === 204) return null;
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error(`Discord ${method} ${path} → ${r.status} ${JSON.stringify(j)?.slice(0, 200)}`);
    return j;
  }
  throw new Error('Discord : trop de requêtes');
}

const lineOf = (x, withTime = true) => {
  const sign = x.action === 'deposit' ? '🟢 **+**' : '🔴 **−**';
  const what = x.kind === 'money' ? `**${$(x.amount)}**${x.item === 'black_money' ? ' *(sale)*' : ''}` : `**${nf.format(x.quantity)}×** ${x.item}`;
  return `${sign} ${what} — ${x.player || '?'}${withTime ? ` · ${t(x.ts, 't')}` : ''}`;
};

// ---------------------------------------------------------------- Synchronisation des logs
async function sync(env) {
  const parse = createParser(CONFIG);
  const DB = env.DB;
  const touched = new Set();
  for (const channelId of Object.keys(CONFIG.channels || {})) {
    let after = (await DB.prepare('SELECT newest_id FROM cursors WHERE channel_id = ?').bind(channelId).first())?.newest_id;
    for (let page = 0; page < 5; page++) {
      const msgs = await dc(env, `/channels/${channelId}/messages?limit=100${after ? `&after=${after}` : ''}`);
      if (!msgs?.length) break;
      msgs.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
      const stmts = [];
      for (const m of msgs) {
        if (!(m.webhook_id || (m.author?.bot && m.author.id !== env.BOT_ID))) continue;
        const plain = {
          id: m.id, channelId, ts: Date.parse(m.timestamp), content: m.content || '',
          embeds: (m.embeds || []).map((e) => ({ title: e.title, description: e.description, author: e.author?.name,
            footer: e.footer?.text, fields: (e.fields || []).map((f) => ({ name: f.name, value: f.value })) })),
        };
        const txs = parse(plain, { defaultCoffre: CONFIG.channels[channelId]?.coffre || null });
        const raw = JSON.stringify({ content: plain.content || undefined, embeds: plain.embeds.length ? plain.embeds : undefined });
        if (!txs.length) {
          stmts.push(DB.prepare('INSERT OR IGNORE INTO unparsed (message_id, channel_id, ts, raw) VALUES (?,?,?,?)').bind(m.id, channelId, plain.ts, raw));
          continue;
        }
        txs.forEach((x, i) => {
          touched.add(x.coffre);
          stmts.push(DB.prepare(`INSERT OR IGNORE INTO transactions (message_id, idx, channel_id, ts, coffre, player, player_id, action, kind, item, quantity, amount, raw)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(m.id, i, channelId, plain.ts, x.coffre, x.player, x.player_id, x.action, x.kind, x.item, x.quantity, x.amount, i === 0 ? raw : null));
        });
      }
      after = msgs.at(-1).id;
      stmts.push(DB.prepare(`INSERT INTO cursors (channel_id, newest_id) VALUES (?,?)
        ON CONFLICT(channel_id) DO UPDATE SET newest_id = excluded.newest_id`).bind(channelId, after));
      await DB.batch(stmts);
      if (msgs.length < 100) break;
    }
  }
  for (const coffre of touched) await updatePanel(env, coffre).catch((e) => console.log('panneau', coffre, e.message));
  return [...touched];
}

// ---------------------------------------------------------------- Panneau d'état épinglé
async function panelEmbed(stats, coffre) {
  const [all, day, week, stock, last] = await Promise.all([
    stats.summary({ coffre }),
    stats.summary({ coffre, from: Date.now() - 86400e3 }),
    stats.players({ coffre, from: weekStart() }, { sort: 'deposit', limit: 8 }),
    stats.stock({ coffre }),
    stats.transactions({ coffre }, { limit: 5 }),
  ]);
  return {
    color: RED,
    title: `📊 État du coffre ${coffre}`,
    fields: [
      { name: '💰 Argent dans le coffre', value: `**${$(all.cash_balance + all.black_balance)}**\n🩸 sale ${$(all.black_balance)}\n💵 propre ${$(all.cash_balance)}`, inline: true },
      { name: '🕐 Dernières 24 h', value: `Argent ${signed(day.cash_in + day.black_in - day.cash_out - day.black_out)}\nItems +${nf.format(day.items_in)} / −${nf.format(day.items_out)}\n${day.n} mouvements`, inline: true },
      { name: '📦 Stock estimé', value: stock.filter((r) => r.net > 0).slice(0, 15).map((r) => `${r.item} : **${nf.format(r.net)}**`).join('\n') || '—' },
      { name: '🏆 Semaine (dépôts)', value: week.filter((p) => p.cash_in + p.black_in > 0).map((p, k) => `${['🥇', '🥈', '🥉'][k] || `${k + 1}.`} **${p.player}** — ${$(p.cash_in + p.black_in)}`).join('\n') || '—' },
      { name: '🕒 Derniers mouvements', value: last.rows.map((x) => lineOf(x)).join('\n').slice(0, 1024) || '—' },
    ],
    footer: { text: `Mis à jour automatiquement · ${nf.format(all.n)} mouvements · ${CONFIG.dashboardUrl || ''}` },
    timestamp: new Date().toISOString(),
  };
}

async function updatePanel(env, coffre) {
  if (CONFIG.panels === false) return;
  const stats = createStats(env.DB);
  const embed = await panelEmbed(stats, coffre);
  const saved = await env.DB.prepare('SELECT * FROM panels WHERE coffre = ?').bind(coffre).first();
  if (saved?.message_id) {
    try { await dc(env, `/channels/${saved.channel_id}/messages/${saved.message_id}`, { method: 'PATCH', body: { embeds: [embed] } }); return; }
    catch (e) { if (!/404/.test(e.message)) throw e; }
  }
  const src = await env.DB.prepare(`SELECT channel_id, COUNT(*) AS n FROM transactions WHERE coffre = ? AND channel_id IS NOT NULL
    GROUP BY channel_id ORDER BY n DESC LIMIT 1`).bind(coffre).first();
  const channelId = saved?.channel_id || src?.channel_id;
  if (!channelId || !CONFIG.channels[channelId]) return;
  const msg = await dc(env, `/channels/${channelId}/messages`, { method: 'POST', body: { embeds: [embed] } });
  await env.DB.prepare(`INSERT INTO panels (coffre, channel_id, message_id) VALUES (?,?,?)
    ON CONFLICT(coffre) DO UPDATE SET channel_id = excluded.channel_id, message_id = excluded.message_id`).bind(coffre, channelId, msg.id).run();
  await dc(env, `/channels/${channelId}/pins/${msg.id}`, { method: 'PUT' }).catch(() => {});
}

// ---------------------------------------------------------------- Commandes slash
const PERIOD_LABEL = { '24h': '24 heures', '7d': '7 jours', '30d': '30 jours', all: 'Tout' };

async function command(env, i) {
  const stats = createStats(env.DB);
  const opts = Object.fromEntries((i.data.options || []).map((o) => [o.name, o.value]));
  const coffre = opts.coffre || null;
  const period = opts.periode || 'all';
  const f = { coffre, ...periodToRange(period) };
  const scope = `${coffre || 'Tous les coffres'} · ${PERIOD_LABEL[period] || 'Tout'}`;
  const reply = (data) => ({ type: 4, data });
  const ephemeral = (content) => reply({ content, flags: 64 });

  switch (i.data.name) {
    case 'stats': {
      const [s, top, items] = await Promise.all([stats.summary(f), stats.players(f, { sort: 'activity', limit: 5 }), stats.items(f, { limit: 5 })]);
      return reply({ embeds: [{ color: RED, title: `📦 ${scope}`, fields: [
        { name: '💰 Argent dans le coffre', value: `**${$(s.cash_balance + s.black_balance)}**`, inline: true },
        { name: '💸 Déposé / retiré', value: `+${$(s.cash_in + s.black_in)}\n−${$(s.cash_out + s.black_out)}`, inline: true },
        { name: '📦 Items', value: `Entrés **${nf.format(s.items_in)}**\nSortis **${nf.format(s.items_out)}**\n${nf.format(s.n)} mouvements`, inline: true },
        { name: '👥 Joueurs les plus actifs', value: top.map((p, k) => `${k + 1}. **${p.player}** — ${p.n} mvts`).join('\n') || '—', inline: true },
        { name: '🔁 Items les plus bougés', value: items.map((x) => `**${x.item}** +${nf.format(x.qty_in)} / −${nf.format(x.qty_out)}`).join('\n') || '—', inline: true },
      ], footer: { text: `${s.players} joueurs · ${s.unparsed} logs non reconnus` } }] });
    }
    case 'joueur': {
      const name = opts.nom;
      const p = (await stats.players({ ...f, player: name }, { limit: 1 }))[0];
      if (!p) return ephemeral(`Aucun mouvement trouvé pour **${name}** (${scope}).`);
      const [items, last] = await Promise.all([stats.items({ ...f, player: name }, { limit: 8 }), stats.transactions({ ...f, player: name }, { limit: 6 })]);
      const net = p.cash_in + p.black_in - p.cash_out - p.black_out;
      return reply({ embeds: [{ color: net >= 0 ? 0x3ddc84 : RED, title: `👤 ${p.player}`, description: scope, fields: [
        { name: '💵 Argent', value: `Déposé **${$(p.cash_in + p.black_in)}**\nRetiré **${$(p.cash_out + p.black_out)}**\nBilan **${signed(net)}**`, inline: true },
        { name: '📦 Items', value: `Déposés **${nf.format(p.items_in)}**\nRetirés **${nf.format(p.items_out)}**\n${p.n} mouvements`, inline: true },
        { name: 'Items', value: items.map((x) => `**${x.item}** +${nf.format(x.qty_in)} / −${nf.format(x.qty_out)}`).join('\n') || '—' },
        { name: 'Derniers mouvements', value: last.rows.map((x) => lineOf(x)).join('\n').slice(0, 1024) || '—' },
      ] }] });
    }
    case 'top': {
      const type = opts.type;
      const rows = await stats.players(f, { sort: type, limit: 10 });
      const label = { deposit: 'Plus gros déposants', withdraw: 'Plus gros retraits', activity: 'Plus actifs', net: 'Bilan le plus négatif', items_out: 'Items retirés' }[type];
      const v = (p) => ({ deposit: $(p.cash_in + p.black_in), withdraw: $(p.cash_out + p.black_out), activity: `${p.n} mvts`,
        net: signed(p.cash_in + p.black_in - p.cash_out - p.black_out), items_out: `${nf.format(p.items_out)} items` }[type]);
      return reply({ embeds: [{ color: RED, title: `🏆 ${label}`, description: `${scope}\n\n${rows.map((p, k) => `\`${String(k + 1).padStart(2)}\` **${p.player}** — ${v(p)}`).join('\n') || 'Aucune donnée.'}` }] });
    }
    case 'classement': {
      const back = Number(opts.semaine || 0);
      let start = weekStart();
      for (let k = 0; k < back; k++) start = weekStart(start - 86400e3);
      const end = weekEnd(start);
      const rows = (await stats.ranking(start, { coffre }, 15)).filter((p) => p.deposited > 0);
      const medal = (k) => ['🥇', '🥈', '🥉'][k] || `\`${String(k + 1).padStart(2)}\``;
      return reply({ embeds: [{ color: RED,
        title: `🏆 Classement — ${back === 0 ? 'semaine en cours' : back === 1 ? 'semaine dernière' : `il y a ${back} semaines`}`,
        description: `Du ${t(start, 'f')} au ${t(end, 'f')}${coffre ? ` · ${coffre}` : ''}\n\n${rows.map((p, k) => `${medal(k)} **${p.player}** — ${$(p.deposited)} déposés`).join('\n') || 'Aucun dépôt d\'argent sur cette semaine.'}`,
        footer: { text: back === 0 ? 'Remise à zéro chaque dimanche à 19h' : 'Semaine archivée' } }] });
    }
    case 'stock': {
      const [s, rows] = await Promise.all([stats.summary({ coffre }), stats.stock({ coffre })]);
      return reply({ embeds: [{ color: RED, title: `🏦 Stock — ${coffre}`,
        description: `💰 Argent : **${$(s.cash_balance + s.black_balance)}**\n\n${rows.filter((r) => r.net !== 0).slice(0, 25).map((r) => `${r.net < 0 ? '⚠️ ' : ''}**${r.item}** : ${nf.format(r.net)}`).join('\n') || 'Aucun item.'}`,
        footer: { text: 'Calculé à partir des logs (entrées − sorties).' } }] });
    }
    case 'recent': {
      const rows = (await stats.transactions({ coffre, player: opts.joueur || null }, { limit: Math.min(25, opts.nombre || 10) })).rows;
      return reply({ embeds: [{ color: RED, title: '🕒 Derniers mouvements', description: rows.map((x) => lineOf(x)).join('\n').slice(0, 4000) || 'Aucun mouvement.' }] });
    }
    case 'dashboard':
      return ephemeral(`📊 Tableau de bord : ${CONFIG.dashboardUrl}`);
    case 'solde': {
      const type = opts.type || 'black_money';
      await stats.setAnchor(coffre, type, Number(opts.montant));
      await updatePanel(env, coffre).catch(() => {});
      return ephemeral(`✅ **${coffre}** : ${$(opts.montant)} ${type === 'black_money' ? 'd\'argent sale' : 'd\'argent propre'} dans le coffre.\nChaque retrait l'enlèvera, chaque dépôt l'ajoutera.`);
    }
    case 'nonreconnus': {
      const rows = await stats.unparsed({ limit: 5 });
      return ephemeral(`Derniers logs non reconnus :\n${rows.map((r) => `\`\`\`${r.raw.slice(0, 300)}\`\`\``).join('\n') || '—'}`.slice(0, 2000));
    }
    default:
      return ephemeral('Commande inconnue.');
  }
}

async function autocomplete(env, i) {
  const stats = createStats(env.DB);
  const focused = (i.data.options || []).find((o) => o.focused);
  const list = focused?.name === 'coffre' ? await stats.coffreNames(focused.value || '') : await stats.playerNames(focused?.value || '');
  return { type: 8, data: { choices: list.slice(0, 25).map((n) => ({ name: String(n).slice(0, 100), value: String(n).slice(0, 100) })) } };
}

// ---------------------------------------------------------------- Vérification de signature Discord
const hex = (h) => new Uint8Array(h.match(/../g).map((b) => parseInt(b, 16)));
async function verify(env, req, body) {
  const sig = req.headers.get('x-signature-ed25519');
  const ts = req.headers.get('x-signature-timestamp');
  if (!sig || !ts) return false;
  const key = await crypto.subtle.importKey('raw', hex(env.DISCORD_PUBLIC_KEY), { name: 'Ed25519' }, false, ['verify']);
  return crypto.subtle.verify('Ed25519', key, hex(sig), new TextEncoder().encode(ts + body));
}

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

/** Point d'entrée des commandes Discord (appelé par la Pages Function /interactions) */
export async function handleInteraction(req, env) {
  const body = await req.text();
  if (!(await verify(env, req, body))) return new Response('signature invalide', { status: 401 });
  const i = JSON.parse(body);
  if (i.type === 1) return json({ type: 1 }); // PING de vérification Discord
  try {
    if (i.type === 4) return json(await autocomplete(env, i));
    if (i.type === 2) return json(await command(env, i));
  } catch (e) {
    console.log('commande', e.stack);
    return json({ type: 4, data: { content: `Erreur : ${e.message}`.slice(0, 1900), flags: 64 } });
  }
  return json({ type: 4, data: { content: '…', flags: 64 } });
}

export { sync, COMMANDS };

export default {
  async fetch() {
    return new Response('NLS Coffres — bot en ligne ✅');
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(sync(env).catch((e) => console.log('sync', e.stack)));
  },
};
