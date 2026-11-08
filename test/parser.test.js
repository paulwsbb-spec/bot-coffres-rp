import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createParser, parseNumber } from '../src/parser.js';
import { loadConfig } from '../src/config.js';

const parse = createParser(loadConfig());
const one = (msg, opts) => {
  const r = parse(msg, opts);
  assert.equal(r.length, 1, `attendu 1 transaction, reçu ${JSON.stringify(r)}`);
  return r[0];
};

test('parseNumber', () => {
  assert.equal(parseNumber('1 234 567'), 1234567);
  assert.equal(parseNumber('$1,234,567'), 1234567);
  assert.equal(parseNumber('1.500'), 1500);
  assert.equal(parseNumber('12k'), 12000);
  assert.equal(parseNumber('2,5'), 2.5);
  assert.equal(parseNumber('abc'), null);
});

test('embed ESX : champs Joueur/Coffre/Objet/Quantité', () => {
  const t = one({ embeds: [{ title: 'Coffre - Dépôt', fields: [
    { name: 'Joueur', value: 'Jean Dupont (ID 12)' },
    { name: 'Coffre', value: 'Vagos' },
    { name: 'Objet', value: 'Pain' },
    { name: 'Quantité', value: '5' },
  ] }] });
  assert.deepEqual(t, { action: 'deposit', kind: 'item', item: 'Pain', quantity: 5, amount: null, player: 'Jean Dupont', player_id: '12', coffre: 'Vagos' });
});

test('embed retrait argent dans la description', () => {
  const t = one({ embeds: [{ title: '📤 Retrait', description: '**Joueur:** Mike Ross\n**Coffre:** LSPD\n**Montant:** 25 000$' }] });
  assert.equal(t.action, 'withdraw');
  assert.equal(t.kind, 'money');
  assert.equal(t.item, 'cash');
  assert.equal(t.amount, 25000);
  assert.equal(t.player, 'Mike Ross');
  assert.equal(t.coffre, 'LSPD');
});

test('phrase FR argent sale', () => {
  const t = one({ content: "Tony Montana a déposé 150 000$ d'argent sale dans le coffre Ballas" });
  assert.equal(t.action, 'deposit');
  assert.equal(t.kind, 'money');
  assert.equal(t.item, 'black_money');
  assert.equal(t.amount, 150000);
  assert.equal(t.player, 'Tony Montana');
  assert.equal(t.coffre, 'Ballas');
});

test('phrase EN ox_inventory', () => {
  const t = one({ content: 'John Smith withdrew 3x WEAPON_PISTOL from stash police_armory' });
  assert.equal(t.action, 'withdraw');
  assert.equal(t.item, 'WEAPON_PISTOL');
  assert.equal(t.quantity, 3);
  assert.equal(t.coffre, 'police_armory');
});

test('phrase EN avec id joueur', () => {
  const t = one({ embeds: [{ description: 'Carl [5] took 10x bandage from stash ambulance' }] });
  assert.equal(t.player, 'Carl');
  assert.equal(t.player_id, '5');
  assert.equal(t.quantity, 10);
  assert.equal(t.item, 'bandage');
});

test('liste à puces multi-items', () => {
  const r = parse({ embeds: [{ title: 'Dépôt coffre Families', description: 'Joueur: Franklin\n- 10x Weed\n- 2x Pistolet' }] });
  assert.equal(r.length, 2);
  assert.equal(r[0].coffre, 'Families');
  assert.equal(r[0].player, 'Franklin');
  assert.equal(r[1].item, 'Pistolet');
  assert.equal(r[1].quantity, 2);
});

test('forme passive "par"', () => {
  const t = one({ content: 'Retrait de 5 Eau par Lamar dans Coffre Families' });
  assert.equal(t.action, 'withdraw');
  assert.equal(t.item, 'Eau');
  assert.equal(t.quantity, 5);
  assert.equal(t.player, 'Lamar');
  assert.equal(t.coffre, 'Families');
});

test('coffre par défaut du salon', () => {
  const t = one({ content: 'Lester a pris 2 Ordinateur' }, { defaultCoffre: 'Planque' });
  assert.equal(t.coffre, 'Planque');
  assert.equal(t.action, 'withdraw');
});

test('vrai format serveur : titre = coffre, argent sale en "x"', () => {
  const t = one({ embeds: [{ title: 'Flat 3 Quartier 1', description: '**Jean Martin** a déposé 73570x Argent Sale' }] });
  assert.deepEqual(t, { action: 'deposit', kind: 'money', item: 'black_money', quantity: 73570, amount: 73570, player: 'Jean Martin', player_id: null, coffre: 'Flat 3 Quartier 1' });
});

test('vrai format serveur : retrait d\'item', () => {
  const t = one({ embeds: [{ title: 'Flat 3 Quartier 1', description: '**Paul Durand** a retiré 12x Pistolet' }] });
  assert.equal(t.action, 'withdraw');
  assert.equal(t.kind, 'item');
  assert.equal(t.item, 'Pistolet');
  assert.equal(t.quantity, 12);
  assert.equal(t.coffre, 'Flat 3 Quartier 1');
});

test('vrai format serveur : 10 logs regroupés, "À 50" dans le nom, numéro de série', () => {
  const E = (d) => ({ title: 'Flat 3 Quartier 1', description: d, fields: [] });
  const r = parse({ embeds: [
    E('**Jean Martin** a déposé 5626x Argent Sale'),
    E('**Paul Durand** a déposé 1x SNS Pico (VVVPVGPGKS)'),
    E('**Paul Durand** a déposé 2x Vénia Purifier À 50'),
    E('**Jean Martin** a retiré 1x Pistolet SNS (W6WEHSLTWU)'),
    E('**Jean Martin** a déposé 1x Table De Jus De Mangue 3'),
  ] });
  assert.equal(r.length, 5);
  assert.ok(r.every((t) => t.coffre === 'Flat 3 Quartier 1'));
  assert.deepEqual(r.map((t) => [t.player, t.action, t.item, t.quantity]), [
    ['Jean Martin', 'deposit', 'black_money', 5626],
    ['Paul Durand', 'deposit', 'SNS Pico', 1],
    ['Paul Durand', 'deposit', 'Vénia Purifier À 50', 2],
    ['Jean Martin', 'withdraw', 'Pistolet SNS', 1],
    ['Jean Martin', 'deposit', 'Table De Jus De Mangue 3', 1],
  ]);
});

test('message "Webhook configuré" ignoré', () => {
  assert.deepEqual(parse({ content: 'Webhook Flat 3 Quartier 4 configuré pour la propriété 191249 par Jean Martin' }), []);
});

test('message non pertinent ignoré', () => {
  assert.deepEqual(parse({ content: 'Serveur redémarré, bon jeu à tous' }), []);
});

test('règle personnalisée', () => {
  const p = createParser({ ...loadConfig(), rules: [{
    pattern: '^\\[(?<action>IN|OUT)\\] (?<player>[^|]+) \\| (?<item>[^|]+) \\| (?<qty>\\d+) \\| (?<coffre>.+)$',
    actionMap: { IN: 'deposit', OUT: 'withdraw' },
  }] });
  const r = p({ content: '[OUT] Trevor | Lockpick | 4 | Garage Sandy' });
  assert.equal(r.length, 1);
  assert.deepEqual(r[0], { action: 'withdraw', kind: 'item', item: 'Lockpick', quantity: 4, amount: null, player: 'Trevor', player_id: null, coffre: 'Garage Sandy' });
});
