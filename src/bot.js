import {
  Client, GatewayIntentBits, Partials, Events, EmbedBuilder, SlashCommandBuilder,
  PermissionFlagsBits, REST, Routes,
} from 'discord.js';
import { bus, inTransaction, snowflakeGt, reparseAll } from './db.js';
import { periodToRange, weekStart, weekEnd } from './stats.js';
import { createRouter, slugify } from './router.js';

// ---------- Format ----------
const nf = new Intl.NumberFormat('fr-FR');
const $ = (n) => `${nf.format(Math.round(n || 0))} $`;
const signed = (n) => `${n >= 0 ? '+' : '−'}${$(Math.abs(n))}`;
const COLORS = { brand: 0xf5b301, in: 0x22c55e, out: 0xef4444, info: 0x3b82f6 };
const PERIODS = [
  { name: '24 heures', value: '24h' }, { name: '7 jours', value: '7d' },
  { name: '30 jours', value: '30d' }, { name: 'Tout', value: 'all' },
];
const periodLabel = (p) => PERIODS.find((x) => x.value === p)?.name || 'Tout';
const ts = (ms) => `<t:${Math.floor(ms / 1000)}:R>`;
const txLine = (t) => {
  const arrow = t.action === 'deposit' ? '🟢 +' : '🔴 −';
  const what = t.kind === 'money' ? `${$(t.amount)}${t.item === 'black_money' ? ' (sale)' : ''}` : `${nf.format(t.quantity)}× ${t.item}`;
  return `${arrow} ${what} · **${t.player || '?'}** · ${t.coffre} · ${ts(t.ts)}`;
};

export function toPlain(m) {
  return {
    id: m.id,
    channelId: m.channelId,
    ts: m.createdTimestamp,
    content: m.content || '',
    embeds: (m.embeds || []).map((e) => ({
      title: e.title || undefined,
      description: e.description || undefined,
      author: e.author?.name || undefined,
      footer: e.footer?.text || undefined,
      fields: (e.fields || []).map((f) => ({ name: f.name, value: f.value })),
    })),
  };
}

// ---------- Commandes ----------
const coffreOpt = (o) => o.setName('coffre').setDescription('Coffre').setAutocomplete(true);
const periodOpt = (o) => o.setName('periode').setDescription('Période').addChoices(...PERIODS);

export const commands = [
  new SlashCommandBuilder().setName('stats').setDescription('Statistiques d\'un coffre (ou de tous)')
    .addStringOption(coffreOpt).addStringOption(periodOpt),
  new SlashCommandBuilder().setName('joueur').setDescription('Profil d\'un joueur : dépôts, retraits, items')
    .addStringOption((o) => o.setName('nom').setDescription('Nom du joueur').setRequired(true).setAutocomplete(true))
    .addStringOption(coffreOpt).addStringOption(periodOpt),
  new SlashCommandBuilder().setName('top').setDescription('Classement des joueurs')
    .addStringOption((o) => o.setName('type').setDescription('Classement').setRequired(true).addChoices(
      { name: 'Plus gros déposants', value: 'deposit' },
      { name: 'Plus gros retraits', value: 'withdraw' },
      { name: 'Plus actifs', value: 'activity' },
      { name: 'Suspects (prennent > déposent)', value: 'net' },
      { name: 'Items retirés', value: 'items_out' },
    ))
    .addStringOption(coffreOpt).addStringOption(periodOpt),
  new SlashCommandBuilder().setName('stock').setDescription('Stock estimé d\'un coffre (entrées − sorties)')
    .addStringOption((o) => coffreOpt(o).setRequired(true)),
  new SlashCommandBuilder().setName('recent').setDescription('Derniers mouvements')
    .addStringOption(coffreOpt)
    .addStringOption((o) => o.setName('joueur').setDescription('Filtrer par joueur').setAutocomplete(true))
    .addIntegerOption((o) => o.setName('nombre').setDescription('Nombre (max 25)').setMinValue(1).setMaxValue(25)),
  new SlashCommandBuilder().setName('dashboard').setDescription('Lien vers le tableau de bord web'),
  new SlashCommandBuilder().setName('nonreconnus').setDescription('Logs que le parseur n\'a pas compris (pour ajuster les règles)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('classement').setDescription('Classement des joueurs par argent déposé (semaine du dimanche 19h au dimanche 19h)')
    .addIntegerOption((o) => o.setName('semaine').setDescription('Quelle semaine').addChoices(
      { name: 'Semaine en cours', value: 0 }, { name: 'Semaine dernière', value: 1 },
      { name: 'Il y a 2 semaines', value: 2 }, { name: 'Il y a 3 semaines', value: 3 }))
    .addStringOption(coffreOpt),
  new SlashCommandBuilder().setName('solde').setDescription('Indique combien il y a VRAIMENT dans un coffre maintenant (point de départ du calcul)')
    .addStringOption((o) => coffreOpt(o).setRequired(true))
    .addIntegerOption((o) => o.setName('montant').setDescription('Montant actuel dans le coffre, ex : 586737').setRequired(true).setMinValue(0))
    .addStringOption((o) => o.setName('type').setDescription('Type d\'argent').addChoices(
      { name: 'Argent sale', value: 'black_money' }, { name: 'Argent propre', value: 'cash' }))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('salons').setDescription('Vérifie dans quel salon chaque coffre est rangé + met à jour les panneaux')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('classer').setDescription('Reposte l\'historique des mouvements dans le salon de chaque coffre')
    .addStringOption((o) => o.setName('periode').setDescription('Depuis quand').setRequired(true).addChoices(...PERIODS))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('resync').setDescription('Ré-analyse les logs (après modification des règles du parseur)')
    .addStringOption((o) => o.setName('mode').setDescription('Source').addChoices(
      { name: 'Logs déjà stockés (rapide)', value: 'local' },
      { name: 'Tout retélécharger depuis Discord', value: 'discord' },
    ))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
].map((c) => c.toJSON());

// ---------- Bot ----------
export async function startBot({ db, cfg, env, stats, ingest }) {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Channel],
  });

  const router = createRouter({ client, db, cfg, stats, env });
  const channelIds = Object.keys(cfg.channels || {}).filter((id) => /^\d{15,25}$/.test(id));
  const getCursor = db.prepare('SELECT * FROM cursors WHERE channel_id = ?');
  const upsertCursor = db.prepare(`INSERT INTO cursors (channel_id, oldest_id, newest_id, backfill_done, scanned)
    VALUES (?,?,?,?,?) ON CONFLICT(channel_id) DO UPDATE SET
    oldest_id=excluded.oldest_id, newest_id=excluded.newest_id, backfill_done=excluded.backfill_done, scanned=excluded.scanned`);

  const accept = (m) => m.webhookId || (m.author?.bot && m.author.id !== client.user?.id) || cfg.acceptNonWebhookMessages;
  const defaultCoffre = (ch) => cfg.channels[ch.id]?.coffre || null;
  const backfillState = { running: false, progress: {} };

  async function backfillChannel(channel) {
    let cur = getCursor.get(channel.id) || { channel_id: channel.id, oldest_id: null, newest_id: null, backfill_done: 0, scanned: 0 };
    const save = () => upsertCursor.run(channel.id, cur.oldest_id, cur.newest_id, cur.backfill_done, cur.scanned);
    const ingestBatch = (msgs) => inTransaction(db, () => {
      for (const m of msgs) if (accept(m)) ingest(toPlain(m), { defaultCoffre: defaultCoffre(channel), emit: false });
    });
    const sortAsc = (coll) => [...coll.values()].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));

    // 1. Remonte l'historique (reprend là où on s'était arrêté si le bot a été coupé)
    if (!cur.backfill_done) {
      let before = cur.oldest_id || undefined;
      for (;;) {
        const batch = await channel.messages.fetch({ limit: 100, before, cache: false });
        if (!batch.size) break;
        const msgs = sortAsc(batch);
        ingestBatch(msgs);
        cur.oldest_id = msgs[0].id;
        if (snowflakeGt(msgs.at(-1).id, cur.newest_id)) cur.newest_id = msgs.at(-1).id;
        cur.scanned += batch.size;
        save();
        backfillState.progress[channel.id] = cur.scanned;
        if (cur.scanned % 2000 < 100) console.log(`[backfill] #${channel.name} : ${cur.scanned} messages lus…`);
        before = cur.oldest_id;
      }
      cur.backfill_done = 1;
      save();
    }
    // 2. Rattrape ce qui a été posté pendant que le bot était éteint
    let after = cur.newest_id;
    while (after) {
      const batch = await channel.messages.fetch({ limit: 100, after, cache: false });
      if (!batch.size) break;
      const msgs = sortAsc(batch);
      ingestBatch(msgs);
      cur.newest_id = msgs.at(-1).id;
      cur.scanned += batch.size;
      save();
      after = batch.size === 100 ? cur.newest_id : null;
    }
    console.log(`[backfill] #${channel.name} terminé (${cur.scanned} messages au total)`);
  }

  async function backfillAll() {
    if (backfillState.running) return;
    backfillState.running = true;
    try {
      for (const id of channelIds) {
        try {
          const ch = await client.channels.fetch(id);
          if (!ch?.isTextBased()) { console.warn(`[backfill] salon ${id} introuvable ou non textuel`); continue; }
          await backfillChannel(ch);
        } catch (e) { console.error(`[backfill] salon ${id} :`, e.message); }
      }
      bus.emit('refresh');
      await router.updateAllPanels().catch((e) => console.error('[panneau]', e.message));
    } finally { backfillState.running = false; }
  }

  // ---------- Alertes temps réel ----------
  async function checkAlerts(added) {
    if (!cfg.alertChannelId) return;
    const a = cfg.alerts || {};
    const watch = (a.watchItems || []).map((w) => w.toLowerCase());
    const hits = added.filter((t) => t.action === 'withdraw' && (
      (t.kind === 'money' && t.amount >= a.moneyWithdrawThreshold) ||
      (t.kind === 'item' && t.quantity >= a.itemWithdrawThreshold) ||
      (t.kind === 'item' && watch.some((w) => t.item.toLowerCase().includes(w)))));
    if (!hits.length) return;
    const ch = await client.channels.fetch(cfg.alertChannelId).catch(() => null);
    if (!ch?.isTextBased()) return;
    for (const t of hits) {
      const p = stats.players({ player: t.player }, { limit: 1 })[0];
      const e = new EmbedBuilder().setColor(COLORS.out).setTitle('🚨 Retrait à surveiller')
        .setDescription(txLine(t))
        .setTimestamp(t.ts);
      if (p) e.addFields({ name: `Bilan de ${t.player}`, value:
        `Argent : déposé ${$(p.cash_in + p.black_in)} · retiré ${$(p.cash_out + p.black_out)}\nItems : +${nf.format(p.items_in)} / −${nf.format(p.items_out)}` });
      await ch.send({ embeds: [e] }).catch((err) => console.error('[alerte]', err.message));
    }
  }

  // ---------- Événements ----------
  client.once(Events.ClientReady, async (c) => {
    console.log(`[bot] connecté en tant que ${c.user.tag}`);
    try {
      const rest = new REST().setToken(env.token);
      const route = env.guildId ? Routes.applicationGuildCommands(c.user.id, env.guildId) : Routes.applicationCommands(c.user.id);
      await rest.put(route, { body: commands });
      console.log(`[bot] ${commands.length} commandes slash enregistrées${env.guildId ? '' : ' (globales, ~1h de propagation)'}`);
    } catch (e) { console.error('[bot] enregistrement des commandes :', e.message); }
    if (!channelIds.length) console.warn('[bot] Aucun salon configuré dans config.json > channels');
    backfillAll();
  });

  client.on(Events.MessageCreate, (m) => {
    if (!channelIds.includes(m.channelId) || !accept(m)) return;
    const added = ingest(toPlain(m), { defaultCoffre: defaultCoffre(m.channel) });
    db.prepare('UPDATE cursors SET newest_id = ? WHERE channel_id = ? AND (newest_id IS NULL OR CAST(newest_id AS INTEGER) < CAST(? AS INTEGER))')
      .run(m.id, m.channelId, m.id);
    if (added.length) {
      router.route(added).catch((e) => console.error('[tri]', e.message));
      checkAlerts(added).catch(() => {});
    }
  });

  client.on(Events.InteractionCreate, async (i) => {
    try {
      if (i.isAutocomplete()) {
        const f = i.options.getFocused(true);
        const list = f.name === 'coffre' ? stats.coffreNames(f.value) : stats.playerNames(f.value);
        return i.respond(list.slice(0, 25).map((n) => ({ name: String(n).slice(0, 100), value: String(n).slice(0, 100) })));
      }
      if (!i.isChatInputCommand()) return;
      await handleCommand(i);
    } catch (e) {
      console.error('[commande]', e);
      const payload = { content: `Erreur : ${e.message}`, ephemeral: true };
      if (i.isRepliable()) (i.deferred || i.replied ? i.followUp(payload) : i.reply(payload)).catch(() => {});
    }
  });

  async function handleCommand(i) {
    const coffre = i.options.getString('coffre') || null;
    const period = i.options.getString('periode') || 'all';
    const f = { coffre, ...periodToRange(period) };
    const scope = `${coffre || 'Tous les coffres'} · ${periodLabel(period)}`;

    switch (i.commandName) {
      case 'stats': {
        const s = stats.summary(f);
        const top = stats.players(f, { sort: 'activity', limit: 5 });
        const items = stats.items(f, { limit: 5 });
        const e = new EmbedBuilder().setColor(COLORS.brand).setTitle(`📦 ${scope}`)
          .addFields(
            { name: '💵 Argent propre', value: `Déposé **${$(s.cash_in)}**\nRetiré **${$(s.cash_out)}**\nNet **${signed(s.cash_in - s.cash_out)}**`, inline: true },
            { name: '🩸 Argent sale', value: `Déposé **${$(s.black_in)}**\nRetiré **${$(s.black_out)}**\nNet **${signed(s.black_in - s.black_out)}**`, inline: true },
            { name: '📦 Items', value: `Entrés **${nf.format(s.items_in)}**\nSortis **${nf.format(s.items_out)}**\n${nf.format(s.n)} mouvements`, inline: true },
            { name: '🏦 Solde estimé (tout l\'historique)', value: `Propre ${$(s.cash_balance)} · Sale ${$(s.black_balance)}` },
            { name: '👥 Joueurs les plus actifs', value: top.map((p, k) => `${k + 1}. **${p.player}** — ${p.n} mvts`).join('\n') || '—', inline: true },
            { name: '🔁 Items les plus bougés', value: items.map((t) => `**${t.item}** +${nf.format(t.qty_in)} / −${nf.format(t.qty_out)}`).join('\n') || '—', inline: true },
          )
          .setFooter({ text: `${s.players} joueurs · ${s.unparsed} logs non reconnus` });
        return i.reply({ embeds: [e] });
      }

      case 'joueur': {
        const name = i.options.getString('nom');
        const p = stats.players({ ...f, player: name }, { limit: 1 })[0];
        if (!p) return i.reply({ content: `Aucun mouvement trouvé pour **${name}** (${scope}).`, ephemeral: true });
        const items = stats.items({ ...f, player: name }, { limit: 8 });
        const last = stats.transactions({ ...f, player: name }, { limit: 6 }).rows;
        const moneyNet = p.cash_in + p.black_in - p.cash_out - p.black_out;
        const e = new EmbedBuilder().setColor(moneyNet >= 0 ? COLORS.in : COLORS.out)
          .setTitle(`👤 ${p.player}${p.player_id ? ` (ID ${p.player_id})` : ''}`).setDescription(scope)
          .addFields(
            { name: '💵 Argent', value: `Déposé **${$(p.cash_in + p.black_in)}**\nRetiré **${$(p.cash_out + p.black_out)}**\nBilan **${signed(moneyNet)}**`, inline: true },
            { name: '📦 Items', value: `Déposés **${nf.format(p.items_in)}**\nRetirés **${nf.format(p.items_out)}**\n${p.n} mouvements · ${p.coffres} coffre(s)`, inline: true },
            { name: 'Items', value: items.map((t) => `**${t.item}** +${nf.format(t.qty_in)} / −${nf.format(t.qty_out)}`).join('\n') || '—' },
            { name: 'Derniers mouvements', value: last.map(txLine).join('\n').slice(0, 1024) || '—' },
          );
        return i.reply({ embeds: [e] });
      }

      case 'top': {
        const type = i.options.getString('type');
        const rows = stats.players(f, { sort: type, limit: 10 });
        const label = {
          deposit: 'Plus gros déposants', withdraw: 'Plus gros retraits', activity: 'Plus actifs',
          net: 'Bilan le plus négatif', items_out: 'Items retirés',
        }[type];
        const line = (p, k) => {
          const net = p.cash_in + p.black_in - p.cash_out - p.black_out;
          const v = {
            deposit: $(p.cash_in + p.black_in), withdraw: $(p.cash_out + p.black_out), activity: `${p.n} mvts`,
            net: `${signed(net)} · items ${nf.format(p.items_in - p.items_out)}`, items_out: `${nf.format(p.items_out)} items`,
          }[type];
          return `\`${String(k + 1).padStart(2)}\` **${p.player}** — ${v}`;
        };
        const e = new EmbedBuilder().setColor(type === 'net' ? COLORS.out : COLORS.brand)
          .setTitle(`🏆 ${label}`).setDescription(`${scope}\n\n${rows.map(line).join('\n') || 'Aucune donnée.'}`);
        return i.reply({ embeds: [e] });
      }

      case 'stock': {
        const s = stats.summary({ coffre });
        const rows = stats.stock({ coffre }).filter((r) => r.net !== 0).slice(0, 25);
        const e = new EmbedBuilder().setColor(COLORS.info).setTitle(`🏦 Stock estimé — ${coffre}`)
          .setDescription(`💵 Argent propre : **${$(s.cash_balance)}**\n🩸 Argent sale : **${$(s.black_balance)}**\n\n` +
            (rows.map((r) => `${r.net < 0 ? '⚠️ ' : ''}**${r.item}** : ${nf.format(r.net)}`).join('\n') || 'Aucun item.'))
          .setFooter({ text: 'Calculé à partir des logs (entrées − sorties). Négatif = items présents avant le début des logs.' });
        return i.reply({ embeds: [e] });
      }

      case 'recent': {
        const n = i.options.getInteger('nombre') || 10;
        const player = i.options.getString('joueur') || null;
        const rows = stats.transactions({ coffre, player }, { limit: n }).rows;
        const e = new EmbedBuilder().setColor(COLORS.info).setTitle('🕒 Derniers mouvements')
          .setDescription(rows.map(txLine).join('\n').slice(0, 4000) || 'Aucun mouvement.');
        return i.reply({ embeds: [e] });
      }

      case 'dashboard':
        return i.reply({ content: `📊 Tableau de bord : ${env.dashboardUrl}`, ephemeral: true });

      case 'nonreconnus': {
        const rows = stats.unparsed({ limit: 5 });
        const total = stats.summary({}).unparsed;
        const body = rows.map((r) => `\`\`\`${JSON.stringify(JSON.parse(r.raw)).slice(0, 350)}\`\`\``).join('\n');
        return i.reply({ ephemeral: true, content: `**${total}** logs non reconnus. Derniers exemples :\n${body || '—'}`.slice(0, 2000) });
      }

      case 'classement': {
        const back = i.options.getInteger('semaine') || 0;
        const s = new Date(weekStart()); s.setDate(s.getDate() - 7 * back);
        const start = s.getTime(); const end = weekEnd(start);
        const rows = stats.ranking(start, { coffre }, 15).filter((p) => p.deposited > 0);
        const d = (ms) => `<t:${Math.floor(ms / 1000)}:f>`;
        const medal = (k) => ['🥇', '🥈', '🥉'][k] || `\`${String(k + 1).padStart(2)}\``;
        const e = new EmbedBuilder().setColor(0xd71f26)
          .setTitle(`🏆 Classement — ${back === 0 ? 'semaine en cours' : back === 1 ? 'semaine dernière' : `il y a ${back} semaines`}`)
          .setDescription(`Du ${d(start)} au ${d(end)}${coffre ? ` · ${coffre}` : ''}\n\n` +
            (rows.map((p, k) => `${medal(k)} **${p.player}** — ${$(p.deposited)} déposés`).join('\n') || 'Aucun dépôt d\'argent sur cette semaine.'))
          .setFooter({ text: back === 0 ? 'Remise à zéro chaque dimanche à 19h' : 'Semaine archivée' });
        return i.reply({ embeds: [e] });
      }

      case 'solde': {
        const montant = i.options.getInteger('montant');
        const type = i.options.getString('type') || 'black_money';
        stats.setAnchor(coffre, type, montant);
        bus.emit('refresh');
        router.updatePanel(coffre).catch(() => {});
        return i.reply({ content: `✅ **${coffre}** : ${$(montant)} ${type === 'black_money' ? 'd\'argent sale' : 'd\'argent propre'} dans le coffre.\nChaque retrait l'enlèvera, chaque dépôt l'ajoutera.`, ephemeral: true });
      }

      case 'salons': {
        await i.deferReply({ ephemeral: true });
        const rows = router.mapping();
        await router.updateAllPanels();
        const body = rows.map((r) => (r.channel
          ? `${r.ok ? '✅' : '⛔'} **${r.coffre}** → ${r.channel}${r.ok ? '' : ' *(le bot n\'a pas accès : ajoute son rôle au salon)*'}`
          : `❓ **${r.coffre}** → aucun salon nommé #${slugify(r.coffre)}`)).join('\n');
        return i.editReply(`**Rangement des coffres**\n${body || 'Aucun coffre en base pour l\'instant.'}\n\nPanneaux d'état mis à jour.`);
      }

      case 'classer': {
        await i.deferReply({ ephemeral: true });
        const report = await router.classerHistorique({ from: periodToRange(period).from || null });
        return i.editReply(`**Historique classé (${periodLabel(period)})**\n${report.join('\n') || 'Rien à classer.'}`.slice(0, 2000));
      }

      case 'resync': {
        const mode = i.options.getString('mode') || 'local';
        await i.reply({ content: '🔄 Ré-analyse de l\'historique lancée…', ephemeral: true });
        if (mode === 'local') {
          reparseAll(db, ingest, (id) => cfg.channels[id]?.coffre || null);
          bus.emit('refresh');
        } else {
          db.exec('DELETE FROM cursors');
          await backfillAll();
        }
        const s = stats.summary({});
        return i.followUp({ content: `✅ Terminé : ${nf.format(s.n)} mouvements en base, ${s.unparsed} non reconnus.`, ephemeral: true });
      }
    }
  }

  await client.login(env.token);
  return { client, backfillState };
}
