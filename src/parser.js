// Parseur de logs de coffres GTA RP.
// Entrée : un message Discord "aplati" { content, embeds:[{title, description, fields:[{name,value}], footer, author}] }
// Sortie : liste de transactions { action, kind, item, quantity, amount, player, player_id, coffre }
//
// Stratégie, dans l'ordre :
//   1. règles regex personnalisées (config.rules) — pour coller exactement au format de ton serveur
//   2. champs clé/valeur (fields d'embed ou lignes "Joueur: X")
//   3. phrases libres FR/EN ("X a déposé 5x Pain dans le coffre Y")
//   4. listes à puces ("- 5x Pain") avec action/joueur trouvés ailleurs

// ---------- Nettoyage & nombres ----------

export function clean(s) {
  return String(s ?? '')
    .replace(/(\*\*|__|~~|\|\||`{1,3})/g, '')
    .replace(/<a?:\w+:\d+>/g, '') // emojis custom
    .replace(/[   ]/g, ' ')
    .replace(/^>\s?/gm, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

export function parseNumber(s) {
  if (s == null) return null;
  let t = String(s).replace(/[\s  $€]/g, '');
  let mult = 1;
  const k = /^([\d.,]+)([kKmM])$/.exec(t);
  if (k) { t = k[1]; mult = /k/i.test(k[2]) ? 1e3 : 1e6; }
  if (/^\d{1,3}([.,]\d{3})+$/.test(t)) t = t.replace(/[.,]/g, '');
  else if (/^\d+,\d{1,2}$/.test(t)) t = t.replace(',', '.');
  else t = t.replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = parseFloat(t);
  return Number.isFinite(n) ? n * mult : null;
}

// ---------- Détection d'action ----------

const ACTION_PATTERNS = [
  ['withdraw', /(retir|retrait|\ba pris\b|\bpris\b|\bprend|\bsorti|sortie|took|\btaken?\b|withdr|removed|enlev|r[ée]cup[ée]r|📤|➖)/i],
  ['deposit', /(d[ée]p[oô]s|d[ée]p[oô]t|\ba mis\b|\bmis\b|ajout|\brang[ée]|stock[ée]|\bput\b|deposit|added|stored|plac[ée]|\bentr[ée]e\b|📥|➕)/i],
];

export function detectAction(text) {
  let best = null;
  for (const [action, re] of ACTION_PATTERNS) {
    const m = re.exec(text || '');
    if (m && (best === null || m.index < best.index)) best = { action, index: m.index };
  }
  return best ? best.action : null;
}

// ---------- Synonymes de champs ----------

const KEYS = {
  player: /^(joueur|player|nom du joueur|nom|name|personnage|perso|identit[ée]|utilisateur|user|membre|par|auteur|author|citoyen|character)\b/i,
  playerId: /^(id|identifier|identifiant|license|licence|steam|discord|citizenid|cid|source)\b/i,
  coffre: /^(coffre|stash|vault|inventaire|inventory|stockage|storage|conteneur|container|safe|entrep[oô]t|casier|armoire)\b/i,
  item: /^(item|objet|article|produit|ressource|arme|weapon|label|nom de l'item|item name)\b/i,
  qty: /^(quantit[ée]|qty|quantity|nombre|count|nb|x)\b/i,
  amount: /^(montant|somme|argent|amount|cash|money|valeur|prix)\b/i,
  action: /^(action|type|op[ée]ration|mouvement|[ée]v[ée]nement|event)\b/i,
};

// \b ne fonctionne pas après une lettre accentuée : on remplace par une frontière Unicode
for (const k of Object.keys(KEYS)) {
  KEYS[k] = new RegExp(KEYS[k].source.replace(/\\b$/, '(?![\\p{L}\\p{N}])'), 'iu');
}

function findKey(pairs, kind) {
  const hit = pairs.find(([k]) => KEYS[kind].test(k.trim()));
  return hit ? hit[1] : null;
}

function kvPairs(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*[-•*]?\s*([^:\n]{1,32}?)\s*[:：=]\s*(.+)$/.exec(line);
    if (m && !/^https?$/i.test(m[1])) out.push([m[1].trim(), m[2].trim()]);
  }
  return out;
}

// ---------- Helpers de valeurs ----------

export function splitPlayer(raw) {
  let s = clean(raw);
  let id = null;
  let m;
  if ((m = /<@!?(\d+)>/.exec(s))) { id = m[1]; s = s.replace(m[0], '').trim(); }
  if ((m = /\s*[([]\s*(?:id\s*[:#]?\s*)?([\w:.-]+)\s*[)\]]\s*$/i.exec(s))) { id = id || m[1]; s = s.slice(0, m.index).trim(); }
  if ((m = /^\s*[([]\s*(?:id\s*[:#]?\s*)?([\w:.-]+)\s*[)\]]\s*/i.exec(s))) { id = id || m[1]; s = s.slice(m[0].length).trim(); }
  s = s.replace(/^(le joueur|joueur|player)\s+/i, '').replace(/[.,;]+$/, '').trim();
  return { player: s || null, id };
}

export function splitQtyItem(raw) {
  const s = clean(raw).replace(/[.;]+$/, '').trim();
  const N = '(\\d[\\d\\s.,]*[kKmM]?)';
  const tries = [
    [new RegExp(`^${N}\\s*[x×]\\s*(.+)$`, 'i'), 1, 2],
    [new RegExp(`^[x×]\\s*${N}\\s+(.+)$`, 'i'), 1, 2],
    [new RegExp(`^(.+?)\\s*[x×]\\s*${N}$`, 'i'), 2, 1],
    [new RegExp(`^(.+?)\\s*\\(\\s*[x×]?\\s*${N}\\s*\\)$`, 'i'), 2, 1],
    [new RegExp(`^${N}\\s+(.+)$`, 'i'), 1, 2],
  ];
  for (const [re, qi, ii] of tries) {
    const m = re.exec(s);
    if (m) {
      const qty = parseNumber(m[qi]);
      if (qty != null) return { item: m[ii].trim(), qty };
    }
  }
  return { item: s || null, qty: null };
}

function makeMoneyMatcher(cfg) {
  const norm = (x) => x.toLowerCase().replace(/[_\s]+/g, ' ').trim();
  const black = (cfg.moneyItems?.black_money || []).map(norm);
  const cash = (cfg.moneyItems?.cash || []).map(norm);
  return (label) => {
    const l = norm(label || '').replace(/^(d'|de l'|de |du |en )/, '');
    if (!l) return null;
    if (black.some((w) => l === w || l.includes(w)) || /\b(sale|dirty|black|marqu)/.test(l)) return 'black_money';
    if (cash.some((w) => l === w)) return 'cash';
    if (/^\$$|^(argent|cash|money)\b/.test(l)) return 'cash';
    return null;
  };
}

// Extrait un montant d'argent d'une chaîne "150 000$ d'argent sale" / "$5,000 cash"
function moneyFrom(text, moneyType) {
  const s = clean(text);
  const m = /\$\s*(\d[\d\s.,]*[kKmM]?)|(\d[\d\s.,]*[kKmM]?)\s*(\$|dollars?\b|€)/i.exec(s);
  let amount = null;
  if (m) amount = parseNumber(m[1] || m[2]);
  const rest = s.replace(m ? m[0] : '', ' ');
  let type = moneyType(rest.replace(/^[\s,]*(d'|de |du |en )?/i, '').trim());
  if (!m) {
    // "5000 argent sale" (sans $)
    const { item, qty } = splitQtyItem(s);
    type = moneyType(item);
    if (type && qty != null) amount = qty;
  }
  if (amount == null) return null;
  return { item: type || (/\b(sale|dirty|black)\b/i.test(s) ? 'black_money' : 'cash'), amount };
}

// ---------- Construction d'une transaction ----------

function buildTx({ action, what, qty, amount, player, playerId, coffre }, cfg, moneyType) {
  if (!action) return null;
  let item = what ? clean(what) : null;
  let quantity = qty != null ? parseNumber(qty) ?? qty : null;

  // Argent ?
  const mt = item ? moneyType(item) : null;
  if (amount != null || mt || (item && /\$/.test(item))) {
    let amt = amount != null ? parseNumber(amount) : null;
    let type = mt;
    if (amt == null && item) {
      const mm = moneyFrom(item, moneyType);
      if (mm) { amt = mm.amount; type = type || mm.item; }
    }
    if (amt == null && quantity != null) amt = quantity;
    if (amt != null && (mt || amount != null || /\$/.test(item || ''))) {
      return finalize({ action, kind: 'money', item: type || 'cash', quantity: amt, amount: amt, player, playerId, coffre }, cfg);
    }
  }

  if (!item) return null;
  if (quantity == null) {
    const s = splitQtyItem(item);
    item = s.item;
    quantity = s.qty;
  }
  if (!item) return null;
  return finalize({ action, kind: 'item', item, quantity: quantity ?? 1, amount: null, player, playerId, coffre }, cfg);
}

function finalize(tx, cfg) {
  const p = tx.player ? splitPlayer(tx.player) : { player: null, id: null };
  let item = tx.item;
  if (tx.kind === 'item') {
    item = clean(item).replace(/^(d'|de |du |des )/i, '').replace(/[.,;:]+$/, '').trim();
    const alias = cfg.itemAliases?.[item] ?? cfg.itemAliases?.[item.toLowerCase()];
    if (alias) item = alias;
  }
  let coffre = tx.coffre ? clean(tx.coffre).replace(/^(le |la |l'|du |de la |coffre |stash )+/i, '').replace(/[.,;]+$/, '').trim() : null;
  if (coffre && cfg.coffreAliases?.[coffre]) coffre = cfg.coffreAliases[coffre];
  return {
    action: tx.action,
    kind: tx.kind,
    item,
    quantity: Number(tx.quantity) || 0,
    amount: tx.kind === 'money' ? Number(tx.amount) || 0 : null,
    player: p.player,
    player_id: tx.playerId ? clean(tx.playerId) : p.id,
    coffre: coffre || null,
  };
}

// ---------- Phrases libres ----------

const SENTENCES = [
  // FR : "Jean a déposé 5x Pain dans le coffre Vagos"
  /^(?<player>.+?)\s+(?:a|à|vient de)\s+(?<verb>d[ée]pos[ée]r?|retir[ée]r?|pris|mis|ajout[ée]|sorti|r[ée]cup[ée]r[ée]|rang[ée]|plac[ée]|stock[ée])\s+(?<what>.+?)(?:\s+(?:dans|du|de la|de l'|depuis|au|à|en|sur)\s+(?:l[ae]\s|l')?(?:coffre|stash|inventaire|stockage|casier)?\s*(?<coffre>.*?))?\s*[.!]?$/i,
  // EN : "John withdrew 3x WEAPON_PISTOL from stash police"
  /^(?<player>.+?)\s+(?:has\s+)?(?<verb>deposited|withdrew|withdrawn|took|taken|put|removed|added|stored|placed)\s+(?<what>.+?)(?:\s+(?:into|in|to|from|out of|inside)\s+(?:the\s+)?(?:stash|vault|safe|storage|inventory|container)?\s*(?<coffre>.*?))?\s*[.!]?$/i,
  // Passif : "Retrait de 5 Eau par Lamar (coffre Families)" / "Dépôt de 2000$ par X dans Y"
  /^(?<verb>d[ée]p[oô]t|retrait|deposit|withdraw(?:al)?)\s+(?:de\s+|d'|of\s+)?(?<what>.+?)\s+(?:par|by)\s+(?<player>.+?)(?:\s+(?:dans|du|de|from|into|in|sur)\s+(?:l[ae]\s|l'|the\s)?(?:coffre|stash|vault)?\s*(?<coffre>.*?))?\s*[.!]?$/i,
];

function parseSentence(line, cfg, moneyType) {
  const l = clean(line).replace(/^[-•*]\s*/, '').replace(/^[^\p{L}\p{N}[(<]+/u, '');
  for (const re of SENTENCES) {
    const m = re.exec(l);
    if (!m) continue;
    const g = m.groups;
    const action = detectAction(g.verb);
    const tx = buildTx({ action, what: g.what, player: g.player, coffre: g.coffre || null }, cfg, moneyType);
    if (tx) return tx;
  }
  return null;
}

// ---------- Règles personnalisées ----------

function applyRules(text, cfg, moneyType) {
  const out = [];
  for (const rule of cfg.rules || []) {
    if (!rule?.pattern) continue;
    let re;
    try { re = new RegExp(rule.pattern, (rule.flags || 'i').replace('g', '') + 'gm'); } catch { continue; }
    for (const m of text.matchAll(re)) {
      const g = m.groups || {};
      let action = g.action ? (rule.actionMap?.[g.action] || detectAction(g.action)) : rule.action || null;
      const tx = buildTx({ action, what: g.item, qty: g.qty, amount: g.amount, player: g.player, playerId: g.player_id, coffre: g.coffre || rule.coffre }, cfg, moneyType);
      if (tx) out.push(tx);
    }
  }
  return out;
}

// ---------- Point d'entrée ----------

export function flatten(msg) {
  const parts = [];
  if (msg.content) parts.push(msg.content);
  for (const e of msg.embeds || []) {
    if (e.author) parts.push(e.author);
    if (e.title) parts.push(e.title);
    if (e.description) parts.push(e.description);
    for (const f of e.fields || []) parts.push(`${clean(f.name)}: ${f.value}`);
    if (e.footer) parts.push(e.footer);
  }
  return parts.map(clean).filter(Boolean).join('\n');
}

export function createParser(cfg = {}) {
  const moneyType = makeMoneyMatcher(cfg);

  return function parseMessage(msg, { defaultCoffre = null } = {}) {
    const text = flatten(msg);
    if (!text) return [];
    const withDefaults = (list) =>
      list.map((t) => ({ ...t, coffre: t.coffre || defaultCoffre || 'Coffre inconnu' }));

    // 1. Règles perso
    const ruled = applyRules(text, cfg, moneyType);
    if (ruled.length) return withDefaults(ruled);

    // Contexte global (titre, champs)
    const embedPairs = (msg.embeds || []).flatMap((e) => (e.fields || []).map((f) => [clean(f.name), clean(f.value)]));
    const pairs = [...embedPairs, ...kvPairs(text)];
    const titles = [msg.embeds?.[0]?.title, msg.embeds?.[0]?.author, msg.content?.split('\n')[0]].filter(Boolean).join(' ');
    const actionField = findKey(pairs, 'action');
    const ctx = {
      action: detectAction(actionField || '') || detectAction(titles) || null,
      player: findKey(pairs, 'player'),
      playerId: findKey(pairs, 'playerId'),
      coffre: findKey(pairs, 'coffre'),
    };
    // coffre dans le titre : "Coffre Vagos - Dépôt"
    if (!ctx.coffre) {
      const m = /(?:coffre|stash|vault)\s*[:\-–]?\s*([^\-–|\n]+?)(?:\s*[-–|]|$)/i.exec(titles);
      if (m && !detectAction(m[1])) ctx.coffre = m[1];
    }
    // Titre d'embed sans verbe d'action = nom du coffre (ex. "Flat 3 Quartier 1")
    const embedTitle = clean(msg.embeds?.[0]?.title || '');
    if (!ctx.coffre && embedTitle && cfg.coffreFromTitle !== false && !detectAction(embedTitle) && embedTitle.length <= 60) {
      ctx.coffre = embedTitle;
    }

    // 2. Champs clé/valeur
    const itemVal = findKey(pairs, 'item');
    const qtyVal = findKey(pairs, 'qty');
    const amountVal = findKey(pairs, 'amount');
    const action = ctx.action || detectAction(text);
    if (action && (itemVal || amountVal)) {
      const items = itemVal ? itemVal.split(/\n|,\s(?=\d|x\d)/).filter(Boolean) : [null];
      const out = [];
      for (const it of items) {
        const tx = buildTx({
          action,
          what: it,
          qty: items.length === 1 ? qtyVal : null,
          amount: !it || moneyType(it) ? amountVal || (it && moneyType(it) ? qtyVal : null) : null,
          player: ctx.player,
          playerId: ctx.playerId,
          coffre: ctx.coffre,
        }, cfg, moneyType);
        if (tx) out.push(tx);
      }
      if (out.length) return withDefaults(out);
    }

    // 3. Phrases libres (une transaction par ligne)
    const sentenceTx = [];
    for (const line of text.split('\n')) {
      const tx = parseSentence(line, cfg, moneyType);
      if (tx) {
        if (!tx.coffre && ctx.coffre) tx.coffre = finalize({ ...tx, coffre: ctx.coffre }, cfg).coffre;
        if (!tx.player && ctx.player) Object.assign(tx, { player: splitPlayer(ctx.player).player });
        sentenceTx.push(tx);
      }
    }
    if (sentenceTx.length) return withDefaults(sentenceTx);

    // 4. Liste à puces "- 5x Pain" avec action trouvée dans le titre
    if (action) {
      const out = [];
      for (const line of text.split('\n')) {
        const m = /^\s*[-•*▸►]\s*(.+)$/.exec(line);
        if (!m || /[:：]/.test(m[1])) continue;
        const tx = buildTx({ action, what: m[1], player: ctx.player, playerId: ctx.playerId, coffre: ctx.coffre }, cfg, moneyType);
        if (tx && (tx.kind === 'money' || tx.quantity)) out.push(tx);
      }
      if (out.length) return withDefaults(out);
    }

    return [];
  };
}
