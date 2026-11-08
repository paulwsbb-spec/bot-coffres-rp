// Tri des logs vers les salons des coffres + panneau d'état épinglé dans chaque salon.
//
//  • Chaque mouvement lu dans le salon de logs est reposté, propre, dans le salon du coffre
//    (ex. coffre "flat-3-1" → salon #flat-3-1). Le salon est trouvé par son nom, ou via config.routing.
//  • Chaque salon de coffre a un message "📊 État du coffre" épinglé, mis à jour automatiquement.
import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';

const nf = new Intl.NumberFormat('fr-FR');
const $ = (n) => `${nf.format(Math.round(n || 0))} $`;
const signed = (n) => `${n >= 0 ? '+' : '−'}${$(Math.abs(n))}`;
const ts = (ms, style = 'R') => `<t:${Math.floor(ms / 1000)}:${style}>`;

export const slugify = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export function lineOf(t, { withTime = true } = {}) {
  const sign = t.action === 'deposit' ? '🟢 **+**' : '🔴 **−**';
  const what = t.kind === 'money'
    ? `**${$(t.amount)}**${t.item === 'black_money' ? ' *(sale)*' : ''}`
    : `**${nf.format(t.quantity)}×** ${t.item}`;
  return `${sign} ${what} — ${t.player || '?'}${withTime ? ` · ${ts(t.ts, 't')}` : ''}`;
}

export function createRouter({ client, db, cfg, stats, env }) {
  db.exec(`CREATE TABLE IF NOT EXISTS panels (coffre TEXT PRIMARY KEY, channel_id TEXT, message_id TEXT)`);
  const getPanel = db.prepare('SELECT * FROM panels WHERE coffre = ?');
  const setPanel = db.prepare(`INSERT INTO panels (coffre, channel_id, message_id) VALUES (?,?,?)
    ON CONFLICT(coffre) DO UPDATE SET channel_id = excluded.channel_id, message_id = excluded.message_id`);

  const logChannelIds = new Set(Object.keys(cfg.channels || {}));
  const guild = () => (env.guildId ? client.guilds.cache.get(env.guildId) : client.guilds.cache.first());

  /** Trouve le salon d'un coffre : config.routing d'abord, sinon un salon portant le même nom. */
  function channelFor(coffre) {
    const g = guild();
    if (!g || !coffre) return null;
    const id = cfg.routing?.[coffre];
    if (id) return g.channels.cache.get(id) || null;
    if (cfg.autoRoute === false) return null;
    const slug = slugify(coffre);
    return g.channels.cache.find((c) => c.isTextBased?.() && !c.isThread?.() && !logChannelIds.has(c.id) && slugify(c.name) === slug) || null;
  }

  /** Salon de logs d'où viennent le plus souvent les mouvements de ce coffre */
  const sourceStmt = db.prepare(`SELECT channel_id, COUNT(*) AS n FROM transactions WHERE coffre = ? AND channel_id IS NOT NULL
    GROUP BY channel_id ORDER BY n DESC LIMIT 1`);
  function sourceChannel(coffre) {
    const id = sourceStmt.get(coffre)?.channel_id;
    return id && logChannelIds.has(id) ? guild()?.channels.cache.get(id) || null : null;
  }
  /** Où mettre le panneau : salon dédié s'il existe, sinon le salon où arrivent ses logs */
  const panelChannel = (coffre) => channelFor(coffre) || sourceChannel(coffre);

  function canWrite(ch) {
    const me = ch.guild?.members.me;
    if (!me) return false;
    const p = ch.permissionsFor(me);
    return p?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]);
  }

  const warned = new Set();
  function warnOnce(key, msg) { if (!warned.has(key)) { warned.add(key); console.warn(msg); } }

  // ---------- Tri en temps réel ----------
  async function route(txs) {
    const byCoffre = new Map();
    for (const t of txs) byCoffre.set(t.coffre, [...(byCoffre.get(t.coffre) || []), t]);
    for (const [coffre, list] of byCoffre) {
      schedulePanel(coffre);
      if (cfg.autoRoute === false && !cfg.routing?.[coffre]) continue;
      const ch = channelFor(coffre);
      // Le log est déjà dans son propre salon de coffre (ex. #flat-3-1) : rien à reposter
      if (!ch && list.every((t) => logChannelIds.has(t.channel_id))) continue;
      if (ch && list.every((t) => t.channel_id === ch.id)) continue;
      if (!ch) { warnOnce(`nochan:${coffre}`, `[tri] aucun salon trouvé pour le coffre "${coffre}" (crée #${slugify(coffre)} ou ajoute-le dans config.routing)`); continue; }
      if (!canWrite(ch)) { warnOnce(`perm:${ch.id}`, `[tri] le bot n'a pas accès à #${ch.name} — ajoute son rôle dans les permissions du salon`); continue; }
      const deposit = list.every((t) => t.action === 'deposit');
      const withdraw = list.every((t) => t.action === 'withdraw');
      const e = new EmbedBuilder()
        .setColor(deposit ? 0x22c55e : withdraw ? 0xef4444 : 0xf5b301)
        .setAuthor({ name: `${list[0].player || '?'} · ${deposit ? 'Dépôt' : withdraw ? 'Retrait' : 'Mouvements'}` })
        .setDescription(list.map((t) => lineOf(t, { withTime: false })).join('\n').slice(0, 4000))
        .setTimestamp(list[0].ts);
      await ch.send({ embeds: [e] }).catch((err) => console.error(`[tri] #${ch.name} :`, err.message));
    }
  }

  // ---------- Panneau d'état épinglé ----------
  function panelEmbed(coffre) {
    const all = stats.summary({ coffre });
    const day = stats.summary({ coffre, from: Date.now() - 86400e3 });
    const week = stats.players({ coffre, from: Date.now() - 7 * 86400e3 }, { sort: 'activity', limit: 8 });
    const stock = stats.stock({ coffre }).filter((r) => r.net > 0).slice(0, 15);
    const last = stats.transactions({ coffre }, { limit: 5 }).rows;
    return new EmbedBuilder()
      .setColor(0xf5b301)
      .setTitle(`📊 État du coffre ${coffre}`)
      .addFields(
        { name: '💰 Argent dans le coffre', value: `**${$(all.cash_balance + all.black_balance)}**\n🩸 sale ${$(all.black_balance)}\n💵 propre ${$(all.cash_balance)}`, inline: true },
        { name: '🕐 Dernières 24 h', value: `Argent ${signed(day.cash_in + day.black_in - day.cash_out - day.black_out)}\nItems +${nf.format(day.items_in)} / −${nf.format(day.items_out)}\n${day.n} mouvements`, inline: true },
        { name: '📦 Stock estimé', value: stock.map((r) => `${r.item} : **${nf.format(r.net)}**`).join('\n') || '—' },
        { name: '👥 Joueurs (7 jours)', value: week.map((p) => {
          const net = p.cash_in + p.black_in - p.cash_out - p.black_out;
          return `**${p.player}** — ${p.n} mvts · ${signed(net)}`;
        }).join('\n') || '—' },
        { name: '🕒 Derniers mouvements', value: last.map((t) => lineOf(t)).join('\n').slice(0, 1024) || '—' },
      )
      .setFooter({ text: `Mis à jour automatiquement · ${nf.format(all.n)} mouvements enregistrés` })
      .setTimestamp(new Date());
  }

  async function updatePanel(coffre) {
    if (cfg.panels === false) return;
    const ch = panelChannel(coffre);
    if (!ch || !canWrite(ch)) return;
    const embed = panelEmbed(coffre);
    const saved = getPanel.get(coffre);
    if (saved?.message_id && saved.channel_id === ch.id) {
      const msg = await ch.messages.fetch(saved.message_id).catch(() => null);
      if (msg) { await msg.edit({ embeds: [embed] }).catch((e) => console.error('[panneau]', e.message)); return; }
    }
    const msg = await ch.send({ embeds: [embed] }).catch((e) => { console.error(`[panneau] #${ch.name} :`, e.message); return null; });
    if (!msg) return;
    setPanel.run(coffre, ch.id, msg.id);
    await msg.pin().catch(() => console.warn(`[panneau] impossible d'épingler dans #${ch.name} (permission "Gérer les messages" manquante)`));
  }

  const timers = new Map();
  function schedulePanel(coffre, delay = 15000) {
    clearTimeout(timers.get(coffre));
    timers.set(coffre, setTimeout(() => { timers.delete(coffre); updatePanel(coffre); }, delay));
  }

  async function updateAllPanels() {
    const live = new Set(stats.coffres().map((c) => c.coffre));
    // Supprime les panneaux de coffres qui n'existent plus (ex. coffre mal lu avant une correction)
    for (const p of db.prepare('SELECT * FROM panels').all()) {
      if (live.has(p.coffre)) continue;
      const ch = guild()?.channels.cache.get(p.channel_id);
      const msg = ch ? await ch.messages.fetch(p.message_id).catch(() => null) : null;
      if (msg) await msg.delete().catch(() => {});
      db.prepare('DELETE FROM panels WHERE coffre = ?').run(p.coffre);
    }
    for (const coffre of live) await updatePanel(coffre);
  }

  // ---------- Historique : reposte les anciens mouvements dans les salons ----------
  async function classerHistorique({ from = null, onProgress = () => {} } = {}) {
    const report = [];
    for (const { coffre } of stats.coffres()) {
      const ch = channelFor(coffre);
      if (!ch || !canWrite(ch)) { report.push(`⚠️ ${coffre} : pas de salon accessible`); continue; }
      const rows = db.prepare(`SELECT * FROM transactions WHERE coffre = ? ${from ? 'AND ts >= ?' : ''} ORDER BY ts, id`)
        .all(...(from ? [coffre, from] : [coffre]));
      if (!rows.length) continue;
      // Regroupe par jour, 20 lignes max par message pour ne pas inonder le salon
      const days = new Map();
      for (const t of rows) {
        const d = new Date(t.ts).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
        days.set(d, [...(days.get(d) || []), t]);
      }
      await ch.send({ content: `📚 **Historique du coffre ${coffre}** — ${nf.format(rows.length)} mouvements` });
      for (const [d, list] of days) {
        for (let k = 0; k < list.length; k += 20) {
          const chunk = list.slice(k, k + 20);
          const e = new EmbedBuilder().setColor(0x3b82f6)
            .setTitle(k === 0 ? `📅 ${d}` : null)
            .setDescription(chunk.map((t) => lineOf(t)).join('\n').slice(0, 4000));
          await ch.send({ embeds: [e] });
        }
      }
      report.push(`✅ ${coffre} → #${ch.name} : ${nf.format(rows.length)} mouvements`);
      onProgress(report.at(-1));
      await updatePanel(coffre);
    }
    return report;
  }

  /** Diagnostic : quel coffre va dans quel salon */
  function mapping() {
    return stats.coffres().map(({ coffre, n }) => {
      const ch = panelChannel(coffre);
      return { coffre, n, channel: ch ? `#${ch.name}` : null, ok: ch ? canWrite(ch) : false };
    });
  }

  return { route, updatePanel, updateAllPanels, schedulePanel, classerHistorique, mapping, channelFor };
}
