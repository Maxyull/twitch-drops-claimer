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

## Avant d'ouvrir une pull request

- `npm test` au vert.
- Toute modification de `manifest.json` s'accompagne de la mise à jour de la table des
  permissions dans `docs/AUDIT-SECU.md`, **dans le même commit**.
- Toute nouvelle surface (domaine, permission, type de message, ressource exposée) entre
  dans `docs/AUDIT-SECU.md`, même commit.
