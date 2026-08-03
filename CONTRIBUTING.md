# Contribuer

Extension Chrome MV3, vanilla JS, zéro dépendance à l'exécution.
Cible : Chrome, Edge, Brave. Firefox n'est pas prioritaire.

## Structure

```
/
├── manifest.json              # MV3 uniquement
├── _locales/{fr,en}/messages.json
├── assets/icons/              # 16, 32, 48, 128 px
├── src/
│   ├── background/
│   │   ├── service-worker.js  # alarmes, messages, badge. Aucun état en mémoire longue durée
│   │   ├── gql.js             # client GraphQL Twitch
│   │   ├── farm.js            # orchestrateur : campagnes, chaînes, onglets
│   │   └── notify.js
│   ├── content/
│   │   ├── content.js         # amorce déclarée au manifeste, isolated world
│   │   └── watcher.js         # module chargé dynamiquement (lecteur, clics, battements)
│   ├── lib/                   # modules PURS, testables sous Node, sans API chrome
│   ├── popup/
│   └── options/
├── scripts/{build,bump-version}.py
├── tests/                     # unitaires + régression (node --test), e2e/ en Playwright
├── docs/{AUDIT-SECU,PRIVACY,TESTER-DANS-CHROME}.md
├── dev/                       # prévisualisation locale des vues, hors paquet
└── .github/workflows/ci.yml
```

## Règles non négociables

1. **Manifest V3 uniquement.** Jamais de MV2, jamais de `background.page`.
2. **Zéro code distant.** Pas d'`eval`, `new Function`, pas de CDN. Le seul `import()`
   dynamique pointe vers une ressource du paquet via `chrome.runtime.getURL`.
3. **Permissions minimales.** Chaque permission est justifiée dans `docs/AUDIT-SECU.md`.
   `tests/extension.test.js` échoue si une permission est déclarée sans être utilisée,
   ou si une API est utilisée sans sa permission.
4. **Jamais `innerHTML` avec des données non maîtrisées.** Les noms de campagnes viennent
   de Twitch : `textContent` et `createElement`, point.
5. **Valider tous les messages.** Tout passe par `src/lib/message-guard.js` :
   `sender.id`, allowlist de types (avec `Object.hasOwn`, sinon `constructor` passe),
   origine autorisée, bornes de chaque champ.
6. **`externally_connectable` fermé.**
7. **Pas de secrets dans le code.** Le `Client-Id` de `gql.js` est l'identifiant public
   du client web Twitch. Le jeton de session n'est jamais écrit dans le stockage.
8. **`web_accessible_resources` minimale.** Un test vérifie que la liste vaut exactement
   ce que `watcher.js` importe, ni plus ni moins.

## Conventions

- Modules ES, `type: "module"` dans le service worker.
- `camelCase` pour les fonctions et variables, `SCREAMING_SNAKE` pour les constantes,
  `kebab-case` pour les fichiers.
- Messaging : constantes dans `src/lib/messaging.js`. Jamais de chaîne de type inline,
  un test le vérifie.
- Storage : tout passe par `src/lib/storage.js` (valeurs par défaut, `STORAGE_VERSION`,
  `migrate()`, quota attrapé).
- Service worker : il peut être tué à tout moment. Aucun `setInterval` long, tout par
  `chrome.alarms`, tout état dans `chrome.storage.session` ou `local`.
- Script de contenu : n'injecte **aucun** DOM ni CSS dans la page. S'il fallait le faire
  un jour, préfixer en `tdc-`.
- **`src/lib/` reste pur** : aucune API `chrome`, aucun `fetch`. C'est ce qui rend la
  logique testable sous Node, sans navigateur ni bouchon.
- i18n : `chrome.i18n` et `data-i18n` dans le HTML. Aucun texte d'interface en dur.
  Un test vérifie qu'aucune clé ne manque et qu'aucune n'est morte.
- Code et commentaires en français.

## Tests

```bash
npm test                  # unitaires et régression, sans navigateur
npx playwright test       # e2e sur dist/ réellement chargé dans Chromium
```

Un test minimum par permission demandée : la couverture est vérifiée automatiquement
dans `tests/extension.test.js`. Toute nouvelle règle de sécurité se double d'un test
qui échoue si on retire la règle.

## Build et version

```bash
python scripts/build.py                       # dist/ puis release/*.zip
python scripts/build.py --minify              # avec Terser
python scripts/bump-version.py patch --tag    # manifest.json + package.json + tag git
```

Le zip exclut `tests/`, `docs/`, `dev/`, `scripts/`, `.github/` et `package.json`.

## Workflow

Une modification par branche, une branche par pull request. Jamais de commit direct
sur `main`.

| Situation | Ce qu'on ouvre |
|---|---|
| Une fonctionnalité | une PR `feat/...` |
| Un bug, une faille de sécurité | une **issue** d'abord, puis une PR `fix/...` qui la référence |

### L'issue, pour un bug ou une faille

Elle décrit le symptôme tel qu'il a été constaté, la cause **vérifiée** et non supposée,
l'impact, et ce qui est prévu.

Vérifier avant d'affirmer. Une sonde jetable qui prouve la cause vaut mieux qu'un
raisonnement convaincant : deux fois sur ce dépôt, la cause évidente n'était pas la
bonne. Une hypothèse écartée a sa place dans l'issue, savoir ce qui n'était **pas** la
cause fait gagner du temps à la panne suivante.

### La pull request

Elle référence l'issue avec `Closes #N`, ce qui la ferme au merge. Elle explique ce qui
se passait, pourquoi, et ce qui change. Le titre dit le résultat, pas le fichier touché.

Une PR, une chose. Deux corrections sans rapport font deux PR, même minuscules. Si une
fonctionnalité et un correctif se retrouvent sur la même branche, on sépare avant de
pousser.

### Le merge

Dès que la CI est verte : squash, et suppression de la branche. Pas d'attente de revue,
la trace reste dans la PR.

Si la CI est rouge, elle a raison jusqu'à preuve du contraire. Elle a déjà trouvé des
défauts réels de l'extension sur ce dépôt, pas seulement des tests mal écrits.

## Avant d'ouvrir une pull request

- `npm test` au vert.
- Un correctif s'accompagne du test qui échoue sans lui. Sans ça, rien n'empêche la
  régression de revenir.
- Toute modification de `manifest.json` s'accompagne de la mise à jour de la table des
  permissions dans `docs/AUDIT-SECU.md`, **dans le même commit**.
- Toute nouvelle surface (domaine, permission, type de message, ressource exposée) entre
  dans `docs/AUDIT-SECU.md`, même commit.
