// Module opérations : braquages Fleeca / armurerie (cooldowns + rappels) et transactions (ventes / achats + taxe).
import CONFIG from '../generated/config.json';
import { tzOffset } from '../shared/cstats.js';

const OPS = CONFIG.ops || {};
const nf = new Intl.NumberFormat('fr-FR');
const $ = (n) => `${nf.format(Math.round(n || 0))} $`;
const t = (ms, s = 'f') => `<t:${Math.floor(ms / 1000)}:${s}>`;
const LABEL = { fleeca: '🏦 Fleeca', armurerie: '🔫 Armurerie' };
const COOLDOWN_H = { fleeca: Number(OPS.fleecaCooldownHours) || 48, armurerie: Number(OPS.armurerieCooldownHours) || 72 };
const TAX = Number(OPS.taxRate ?? 0.1);
const CH = OPS.channelIds || {};
const API = 'https://discord.com/api/v10';

const dc = async (env, path, method = 'GET', body) => {
  const r = await fetch(API + path, { method, headers: { Authorization: `Bot ${env.DISCORD_TOKEN}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`Discord ${r.status} ${(await r.text()).slice(0, 150)}`);
  return r.status === 204 ? null : r.json();
};

// ---------- Droits : staff (Admin / Gérer le serveur) ou un des rôles autorisés ----------
let roleCache = null;
async function roleNames(env) {
  if (roleCache && Date.now() - roleCache.at < 10 * 60e3) return roleCache.map;
  const roles = await dc(env, `/guilds/${CONFIG.guildId}/roles`);
  roleCache = { at: Date.now(), map: Object.fromEntries(roles.map((r) => [r.id, r.name])) };
  return roleCache.map;
}
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
export const isStaff = (i) => { const p = BigInt(i.member?.permissions || 0); return (p & 0x8n) !== 0n || (p & 0x20n) !== 0n; };
async function allowed(env, i) {
  if (isStaff(i)) return true;
  const names = await roleNames(env);
  const ok = (OPS.allowedRoles || []).map(norm);
  return (i.member?.roles || []).some((id) => ok.includes(norm(names[id])));
}

// ---------- Dates "10/11/2026 23h", "10/11 23h30", "23:15" (heure de Paris) ----------
export function parseDate(s) {
  if (!s) return Date.now();
  const str = String(s).trim().toLowerCase().replace(/\s+à\s+/, ' ');
  const now = new Date(Date.now() + tzOffset() * 60e3); // "heure de Paris" lue en UTC
  let d = now.getUTCDate(); let mo = now.getUTCMonth() + 1; let y = now.getUTCFullYear(); let h; let mi = 0;
  let m = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?(?:\s+(\d{1,2})\s*[h:]\s*(\d{2})?)?$/.exec(str);
  if (m) { d = +m[1]; mo = +m[2]; if (m[3]) y = m[3].length === 2 ? 2000 + +m[3] : +m[3]; h = m[4] !== undefined ? +m[4] : 12; mi = m[5] ? +m[5] : 0; }
  else if ((m = /^(\d{1,2})\s*[h:]\s*(\d{2})?$/.exec(str))) { h = +m[1]; mi = m[2] ? +m[2] : 0; }
  else return null;
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const ts = guess - tzOffset(guess) * 60e3;
  return Number.isFinite(ts) && mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && h <= 23 && mi <= 59 ? ts : null;
}

const ephemeral = (content) => ({ type: 4, data: { content, flags: 64 } });
const opt = (i) => Object.fromEntries((i.data.options || []).map((o) => [o.name, o.value]));
const who = (i) => ({ id: i.member?.user?.id, name: i.member?.nick || i.member?.user?.global_name || i.member?.user?.username || '?' });

// ---------- /fleeca et /armurerie ----------
async function recordOp(env, i, type) {
  const o = opt(i);
  const ts = parseDate(o.date);
  if (ts === null) return ephemeral('❌ Date non comprise. Exemples : `10/11/2026 23h`, `10/11 23h30`, `21h`.');
  const success = o.resultat === 'reussi' ? 1 : 0;
  const cooldown = success || OPS.cooldownOnFail !== false;
  const nextAt = cooldown ? ts + COOLDOWN_H[type] * 3600e3 : ts;
  const prev = await env.DB.prepare('SELECT * FROM ops WHERE type = ? AND ts <= ? ORDER BY ts DESC LIMIT 1').bind(type, ts).first();
  const early = prev && prev.next_at > ts;
  const me = who(i);
  const loot = o.butin != null ? Number(o.butin) : null;

  const embed = {
    color: success ? 0x3ddc84 : 0xd71f26,
    title: `${LABEL[type]} — ${success ? '✅ Réussi' : '❌ Échec'}`,
    fields: [
      { name: '📅 Date', value: t(ts), inline: true },
      { name: '💰 Butin', value: loot != null ? $(loot) : '—', inline: true },
      { name: '⏳ Prochaine dispo', value: cooldown ? `${t(nextAt)}\n${t(nextAt, 'R')}` : 'Pas de cooldown (échec)', inline: true },
      { name: '👥 Participants', value: o.participants || '—' },
      ...(o.notes ? [{ name: '📝 Notes', value: String(o.notes).slice(0, 1000) }] : []),
      ...(early ? [{ name: '⚠️ Cooldown pas terminé', value: `Le précédent ${LABEL[type]} (${t(prev.ts)}) n'était disponible qu'à partir de ${t(prev.next_at)}. Enregistré quand même.` }] : []),
    ],
    footer: { text: `Enregistré par ${me.name}` },
    timestamp: new Date(ts).toISOString(),
  };
  let messageId = null;
  if (CH[type]) messageId = (await dc(env, `/channels/${CH[type]}/messages`, 'POST', { embeds: [embed] }).catch(() => null))?.id || null;

  // Seul le dernier braquage de chaque type déclenche un rappel
  await env.DB.batch([
    env.DB.prepare('UPDATE ops SET reminded = 1 WHERE type = ? AND ts <= ?').bind(type, ts),
    env.DB.prepare(`INSERT INTO ops (type, success, participants, loot, ts, notes, author_id, author, next_at, reminded, message_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(type, success, o.participants || null, loot, ts, o.notes || null, me.id, me.name, nextAt, cooldown && nextAt > Date.now() ? 0 : 1, messageId),
  ]);
  return ephemeral(`${LABEL[type]} enregistré${CH[type] ? ` dans <#${CH[type]}>` : ''}.${early ? '\n⚠️ Attention : le cooldown du précédent n\'était pas fini.' : ''}`);
}

async function cooldownStatus(env) {
  const out = [];
  for (const type of ['fleeca', 'armurerie']) {
    const last = await env.DB.prepare('SELECT * FROM ops WHERE type = ? ORDER BY ts DESC LIMIT 1').bind(type).first();
    if (!last || last.next_at <= Date.now()) out.push(`${LABEL[type]} : 🟢 **disponible**${last ? ` (dernier : ${t(last.ts)})` : ''}`);
    else out.push(`${LABEL[type]} : 🔴 disponible ${t(last.next_at, 'R')} — ${t(last.next_at)}`);
  }
  return out;
}

// ---------- /transac ----------
async function recordTransac(env, i) {
  const o = opt(i);
  const kind = o.type;
  const amount = Number(o.montant);
  const tax = kind === 'vente' ? Math.round(amount * TAX) : 0;
  const me = who(i);
  const ts = Date.now();
  const embed = {
    color: kind === 'vente' ? 0x3ddc84 : 0xd71f26,
    title: kind === 'vente' ? '💸 Vente' : '🛒 Achat',
    fields: [
      { name: 'Objet', value: String(o.objet).slice(0, 200), inline: true },
      { name: 'Montant', value: $(amount), inline: true },
      ...(o.partenaire ? [{ name: 'Partenaire', value: String(o.partenaire).slice(0, 200), inline: true }] : []),
      ...(kind === 'vente' && TAX > 0 ? [{ name: `Taxe (${Math.round(TAX * 100)} %)`, value: $(tax), inline: true }, { name: 'Net', value: $(amount - tax), inline: true }] : []),
    ],
    footer: { text: `Par ${me.name}` },
    timestamp: new Date(ts).toISOString(),
  };
  await env.DB.prepare('INSERT INTO transacs (kind, amount, object, partner, tax, ts, author_id, author) VALUES (?,?,?,?,?,?,?,?)')
    .bind(kind, amount, o.objet, o.partenaire || null, tax, ts, me.id, me.name).run();
  if (CH.transac) await dc(env, `/channels/${CH.transac}/messages`, 'POST', { embeds: [embed] }).catch(() => {});
  if (kind === 'vente' && TAX > 0 && CH.taxe) {
    await dc(env, `/channels/${CH.taxe}/messages`, 'POST', {
      content: `🧾 ${t(ts, 'd')} · **${String(o.objet).slice(0, 100)}** vendu ${$(amount)} → taxe **${$(tax)}** · par ${me.name}`,
      allowed_mentions: { parse: [] },
    }).catch(() => {});
  }
  return ephemeral(`${kind === 'vente' ? '💸 Vente' : '🛒 Achat'} enregistré${kind === 'vente' && TAX > 0 ? ` · taxe ${$(tax)}` : ''}.`);
}

// ---------- /historique et /bilan ----------
async function history(env, i) {
  const o = opt(i);
  const n = Math.min(25, Number(o.nombre) || 10);
  if (o.type === 'transac') {
    const rows = (await env.DB.prepare('SELECT * FROM transacs ORDER BY ts DESC LIMIT ?').bind(n).all()).results;
    return { type: 4, data: { embeds: [{ color: 0xd71f26, title: '📜 Dernières transactions',
      description: rows.map((r) => `${r.kind === 'vente' ? '💸' : '🛒'} ${t(r.ts, 'd')} · **${r.object}** ${$(r.amount)}${r.partner ? ` · ${r.partner}` : ''}${r.tax ? ` · taxe ${$(r.tax)}` : ''}`).join('\n') || 'Aucune transaction.' }] } };
  }
  const rows = (await env.DB.prepare('SELECT * FROM ops WHERE type = ? ORDER BY ts DESC LIMIT ?').bind(o.type, n).all()).results;
  return { type: 4, data: { embeds: [{ color: 0xd71f26, title: `📜 Historique — ${LABEL[o.type]}`,
    description: rows.map((r) => `${r.success ? '✅' : '❌'} ${t(r.ts)} · ${r.loot != null ? $(r.loot) : '—'}${r.participants ? ` · ${r.participants}` : ''}`).join('\n').slice(0, 4000) || 'Aucune opération.' }] } };
}

async function bilan(env, i) {
  const days = Math.min(365, Number(opt(i).jours) || 7);
  const from = Date.now() - days * 86400e3;
  const [ops, tr] = await Promise.all([
    env.DB.prepare(`SELECT type, COUNT(*) AS n, SUM(success) AS ok, COALESCE(SUM(loot),0) AS loot FROM ops WHERE ts >= ? GROUP BY type`).bind(from).all(),
    env.DB.prepare(`SELECT kind, COUNT(*) AS n, COALESCE(SUM(amount),0) AS total, COALESCE(SUM(tax),0) AS tax FROM transacs WHERE ts >= ? GROUP BY kind`).bind(from).all(),
  ]);
  const op = (type) => ops.results.find((r) => r.type === type) || { n: 0, ok: 0, loot: 0 };
  const tx = (k) => tr.results.find((r) => r.kind === k) || { n: 0, total: 0, tax: 0 };
  const f = op('fleeca'); const a = op('armurerie'); const v = tx('vente'); const ac = tx('achat');
  return { type: 4, data: { flags: 64, embeds: [{ color: 0xd71f26, title: `📊 Bilan — ${days} derniers jours`, fields: [
    { name: '🏦 Fleeca', value: `${f.n} opération(s) · ✅ ${f.ok || 0} / ❌ ${f.n - (f.ok || 0)}\nButin : **${$(f.loot)}**`, inline: true },
    { name: '🔫 Armurerie', value: `${a.n} opération(s) · ✅ ${a.ok || 0} / ❌ ${a.n - (a.ok || 0)}\nButin : **${$(a.loot)}**`, inline: true },
    { name: '💰 Butin total', value: `**${$(f.loot + a.loot)}**`, inline: true },
    { name: '💸 Ventes', value: `${v.n} · **${$(v.total)}**`, inline: true },
    { name: '🛒 Achats', value: `${ac.n} · **${$(ac.total)}**`, inline: true },
    ...(TAX > 0 ? [{ name: '🧾 Taxes', value: `**${$(v.tax)}**`, inline: true }] : []),
  ] }] } };
}

// ---------- Point d'entrée des commandes du module ----------
export const OPS_COMMANDS = new Set(['fleeca', 'armurerie', 'cooldowns', 'historique', 'transac', 'bilan']);

export async function opsCommand(env, i) {
  const name = i.data.name;
  if (name === 'bilan' && !isStaff(i)) return ephemeral('⛔ Réservé au staff.');
  if (!(await allowed(env, i))) return ephemeral(`⛔ Réservé aux rôles : ${(OPS.allowedRoles || []).join(', ')}.`);
  switch (name) {
    case 'fleeca': return recordOp(env, i, 'fleeca');
    case 'armurerie': return recordOp(env, i, 'armurerie');
    case 'cooldowns': return { type: 4, data: { embeds: [{ color: 0xd71f26, title: '⏳ Cooldowns', description: (await cooldownStatus(env)).join('\n') }] } };
    case 'historique': return history(env, i);
    case 'transac': return recordTransac(env, i);
    case 'bilan': return bilan(env, i);
  }
  return ephemeral('Commande inconnue.');
}

// ---------- Rappel automatique (appelé chaque minute par le cron) ----------
export async function remindCooldowns(env) {
  const due = (await env.DB.prepare('SELECT * FROM ops WHERE reminded = 0 AND next_at <= ?').bind(Date.now()).all()).results;
  for (const op of due) {
    const ch = CH[op.type];
    if (ch) {
      await dc(env, `/channels/${ch}/messages`, 'POST', {
        content: `${OPS.reminderRoleId ? `<@&${OPS.reminderRoleId}> ` : ''}🟢 **${LABEL[op.type]} de nouveau disponible !** (dernier : ${t(op.ts)})`,
        allowed_mentions: OPS.reminderRoleId ? { roles: [OPS.reminderRoleId] } : { parse: [] },
      }).catch((e) => console.log('rappel', e.message));
    }
    await env.DB.prepare('UPDATE ops SET reminded = 1 WHERE id = ?').bind(op.id).run();
  }
}
