# Coffres RP — bot Discord + tableau de bord

Lit les logs de coffres envoyés par webhook dans Discord (dépôts / retraits d'argent et d'items),
les stocke dans une base SQLite et sort les stats dans Discord (commandes slash) et sur un dashboard web en temps réel.

- **Anciens logs** : au démarrage, le bot remonte tout l'historique des salons configurés (reprend où il s'était arrêté s'il est coupé).
- **Nouveaux logs** : enregistrés instantanément, poussés en live sur le dashboard, alertes sur les gros retraits.
- **Aucun doublon** : on peut relancer / ré-importer autant qu'on veut.

## Tester tout de suite (sans Discord)

```bash
npm install
npm run demo
```
→ http://localhost:3000 avec ~45 jours de faux logs + un nouveau log toutes les 3,5 s.

## Installation rapide (Windows)

👉 **Tuto pas à pas complet : [TUTO-INSTALLATION.txt](TUTO-INSTALLATION.txt)**

Téléchargement sans navigateur (dans `cmd`, depuis le dossier Documents) :
```
curl -L -o bot.zip https://github.com/paulwsbb-spec/bot-coffres-rp/archive/refs/heads/main.zip && tar -xf bot.zip && del bot.zip && cd bot-coffres-rp-main
```

1. Crée l'application : https://discord.com/developers/applications → **Bot**
   → **Réinitialiser le token** (copie-le) → active **Intention de contenu des messages** → Enregistrer.
2. `npm install` puis `npm run setup` : colle le token, invite le bot avec le lien affiché,
   choisis le salon de logs et le salon d'alertes. L'assistant détecte les salons `#flat-…`,
   vérifie les accès et écrit `.env` + `config.json`.
3. Salons privés 🔒 : donne au rôle du bot *Voir le salon, Envoyer des messages, Intégrer des liens,
   Lire l'historique, Gérer les messages* (le plus simple : sur la catégorie qui contient les salons).
4. `npm start` — garde la fenêtre ouverte.
5. Dans Discord : `/salons` pour vérifier le rangement, puis `/classer` pour ranger l'historique.

## Rangement dans les salons des coffres

Chaque log lu dans le salon de logs est reposté proprement dans le salon du coffre
(coffre `flat-3-1` → salon `#flat-3-1`, trouvé par le nom ; `config.routing` pour forcer un salon).
Chaque salon de coffre reçoit aussi un message **📊 État du coffre** épinglé et mis à jour automatiquement
(solde, 24 h, stock estimé, joueurs, derniers mouvements). Désactivable : `"autoRoute": false`, `"panels": false`.

## Mise en place manuelle

1. **Créer le bot** : https://discord.com/developers/applications → New Application → onglet *Bot*
   - *Reset Token* → copier le token
   - Activer **MESSAGE CONTENT INTENT** (obligatoire pour lire le contenu des webhooks)
2. **Inviter le bot** : onglet *OAuth2 → URL Generator* → scopes `bot` + `applications.commands`,
   permissions `View Channels`, `Read Message History`, `Send Messages`, `Embed Links`. Ouvrir l'URL générée.
3. **Configurer** :
   - copier `.env.example` en `.env`, remplir `DISCORD_TOKEN` et `GUILD_ID`
   - dans `config.json`, mettre l'ID du (des) salon(s) de logs dans `channels` :
     ```json
     "channels": {
       "123456789012345678": { "coffre": null },
       "234567890123456789": { "coffre": "Coffre Vagos" }
     }
     ```
     `coffre` = nom par défaut si le log ne précise pas le coffre (un salon par coffre, par ex.).
   - `alertChannelId` : salon où poster les alertes (vide = pas d'alertes)
4. **Lancer** : `npm start` → bot + dashboard sur http://localhost:3000

## Commandes Discord

| Commande | Rôle |
|---|---|
| `/stats [coffre] [periode]` | Argent propre/sale déposé, retiré, net, solde estimé, top joueurs & items |
| `/joueur nom [coffre] [periode]` | Profil d'un joueur : bilan argent, items, derniers mouvements |
| `/top type [coffre] [periode]` | Classements : déposants, retraits, actifs, suspects, items retirés |
| `/stock coffre` | Stock estimé du coffre (entrées − sorties depuis le début des logs) |
| `/recent [coffre] [joueur] [nombre]` | Derniers mouvements |
| `/dashboard` | Lien vers le tableau de bord |
| `/salons` *(admin)* | Montre dans quel salon va chaque coffre + met à jour les panneaux |
| `/classer periode` *(admin)* | Reposte l'historique dans le salon de chaque coffre (groupé par jour) |
| `/nonreconnus` *(admin)* | Exemples de logs que le parseur n'a pas compris |
| `/resync [mode]` *(admin)* | Ré-analyse après modification des règles (local ou retéléchargement Discord) |

## Importer d'anciens logs depuis un fichier

```bash
npm run import -- export.json              # export DiscordChatExporter (format JSON)
npm run import -- vieux-logs.txt --coffre "Vagos"   # 1 log par ligne, date optionnelle en début
npm run import -- --reparse                # ré-analyse la base avec les règles actuelles
```

## Adapter le parseur à TON format de logs

Le parseur reconnaît déjà automatiquement :
- les embeds avec champs `Joueur / Coffre / Objet / Quantité / Montant` (et synonymes FR/EN)
- les phrases `X a déposé 5x Pain dans le coffre Y`, `X withdrew 3x item from stash Y`, `Retrait de 5 Eau par X`
- les listes à puces `- 10x Weed` sous un titre « Dépôt … »
- l'argent propre / sale (`$`, `argent sale`, `black_money`, `markedbills`…)

Si des logs tombent dans **« non reconnus »** (visible sur le dashboard et via `/nonreconnus`),
ajoute une règle regex dans `config.json` avec des groupes nommés
`player`, `action`, `item`, `qty`, `amount`, `coffre`, `player_id` :

```json
"rules": [
  {
    "pattern": "^\\[(?<action>IN|OUT)\\] (?<player>[^|]+) \\| (?<item>[^|]+) \\| (?<qty>\\d+) \\| (?<coffre>.+)$",
    "actionMap": { "IN": "deposit", "OUT": "withdraw" }
  }
]
```
Puis `/resync` (mode local) ou `npm run import -- --reparse`. Tests : `npm test`.

Autres réglages de `config.json` : `itemAliases` (`"bread": "Pain"` pour fusionner des noms),
`coffreAliases`, `moneyItems`, `alerts.watchItems` (items toujours signalés au retrait, ex. armes).

## Mettre le dashboard en ligne

Mettre `DASHBOARD_PASSWORD` dans `.env` (auth navigateur), ouvrir le port ou passer par un tunnel
(Cloudflare Tunnel, ngrok…), et renseigner `DASHBOARD_URL` pour `/dashboard`.
Le bot doit tourner en continu (PC allumé, VPS, ou hébergeur Node type Railway/Fly — prévoir un disque persistant pour `data/`).

## Structure

```
src/parser.js   détection des transactions dans un message (le cœur)
src/db.js       SQLite (node:sqlite), ingestion idempotente, ré-analyse
src/stats.js    toutes les requêtes stats (partagées bot + web)
src/bot.js      discord.js : import historique, temps réel, slash commands, alertes
src/web.js      serveur HTTP + API JSON + flux live (SSE)
web/            dashboard (HTML/CSS/JS + Chart.js)
scripts/        import de fichiers, démo
```
