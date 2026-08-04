# AUDIT-SECU.md : Twitch Drops & Points (MV3)

Format : 3 passes. Toute case non applicable → `N/A + raison`.
Une bonne partie des cases est **vérifiée automatiquement** par `tests/extension.test.js` :
c'est indiqué par `[test]` en fin de ligne. Ces contrôles tournent à chaque `npm test`.

---

## Table des permissions

| Permission | Justification | Alternative envisagée | Statut |
|---|---|---|---|
| `storage` | Réglages, compteurs, liste « actions requises », cache de campagnes (`local`) ; état des onglets et battements de coeur (`session`). | Aucune : sans stockage, l'extension ne survit pas au redémarrage du service worker. | ✅ |
| `alarms` | Trois boucles périodiques : entretien des onglets (1 min), recherche de campagnes (30 min), passage de réclamation (15 min). Un service worker MV3 ne peut pas tenir un `setInterval`. | `setInterval` dans le SW, rejeté : le worker est tué au bout de 30 s d'inactivité. | ✅ |
| `notifications` | Prévenir d'un drop récupéré et surtout d'une action à faire hors de Twitch (compte à lier). C'est une demande explicite de la fonctionnalité. | Badge seul, rejeté : l'utilisateur ne voit pas passer une campagne bloquée. | ✅ |
| `webRequest` | **Écoute seule**, jamais de blocage ni de modification. Deux usages : reprendre les en-têtes que la page Twitch envoie déjà à son API (dont `Client-Integrity`, sans lequel Twitch répond « failed integrity check »), et observer les requêtes qui prouvent que le visionnage est comptabilisé. | Injecter un script en monde MAIN pour détourner `fetch` dans la page, rejeté : bien plus intrusif, et cela romprait la règle « le script de contenu n'injecte rien ». | ✅ |
| ~~`cookies`~~ | **Non demandée depuis la reprise d'en-têtes.** L'autorisation est reprise de la requête de la page, l'extension ne lit plus aucun cookie. | aucune | ✅ retirée |
| ~~`tabs`~~ | **Non demandée.** `chrome.tabs.create/update/remove/get/reload` fonctionnent sans elle. `chrome.tabs.query` est utilisé pour retrouver les onglets orphelins, mais **toujours filtré par URL** : c'est la permission d'hôte sur `www.twitch.tv` qui donne alors accès au résultat. Un test échoue si un jour la requête part sans filtre, ou avec un motif absent de `host_permissions`. Le titre et le favicon des onglets ne sont jamais lus. | aucune | ✅ retirée |

| Host permission | Justification |
|---|---|
| `https://www.twitch.tv/*` | Script de contenu (lecteur + clics de réclamation) et onglets d'arrière-plan. |
| `https://gql.twitch.tv/*` | API GraphQL de Twitch : liste des campagnes, progression, chaînes en direct. Lecture seule sauf si le « mode rapide » est activé par l'utilisateur. Sert aussi à la reprise d'en-têtes. |
| `https://spade.twitch.tv/*` | **Observation seule.** C'est là que le lecteur Twitch envoie ses pings de comptage du temps de visionnage. Les voir est la seule preuve directe que le visionnage est comptabilisé. |
| `https://*.ttvnw.net/*` | **Observation seule.** CDN vidéo de Twitch. Sous-domaines dynamiques (`video-edge-XXXX.abs.hls.ttvnw.net`), d'où le joker, inévitable. Voir passer les segments prouve que le flux est réellement consommé, ce qui rattrape le cas d'un bloqueur qui tuerait les pings ci-dessus. |

⚠️ Ces deux derniers hôtes ne sont **jamais contactés**, seulement écoutés. Un test de
régression vérifie que le seul `fetch` du code vise `GQL_URL`. Seuls la date et le type
de la requête sont retenus, jamais son contenu ni ses en-têtes.

Aucune permission optionnelle : les quatre permissions ci-dessus sont toutes utilisées
dès le premier cycle de fonctionnement. `[test]` vérifie qu'aucune permission déclarée
n'est inutilisée, et qu'aucune API utilisée n'est sans permission.

### Reprise des en-têtes de la page

Twitch calcule `Client-Integrity` dans son propre JavaScript ; une extension ne peut
pas le fabriquer. L'extension observe donc les requêtes que la page envoie déjà et
réutilise sept en-têtes, listés explicitement dans `src/lib/gql-headers.js` :
`authorization`, `client-id`, `client-integrity`, `client-session-id`,
`client-version`, `device-id`, `x-device-id`, `accept-language`.

Ce qui n'est **jamais** repris, et qu'un test de régression protège : l'en-tête
`Cookie`. Il porte la session complète, notre requête n'en a pas besoin, et le stocker
serait une fuite gratuite.

Conséquence fonctionnelle assumée : sans onglet Twitch ouvert, l'extension ne peut
pas interroger l'API. Elle en ouvre un d'elle-même quand c'est le cas.

---

## PASSE 1 : manifest & surface d'attaque

### Manifest
- [x] `manifest_version: 3`, aucun résidu MV2 `[test]`
- [x] `permissions` : chaque entrée présente dans la table ci-dessus `[test]`
- [x] `host_permissions` : quatre hôtes, dont un seul joker de sous-domaine
      (`*.ttvnw.net`), justifié plus haut par les sous-domaines dynamiques du CDN vidéo.
      Aucun joker de TLD. `[test]`
- [x] Pas de `<all_urls>` `[test]`
- [x] `optional_permissions` : vide. N/A, toutes les permissions sont utilisées au démarrage
- [x] `content_scripts.matches` : `https://www.twitch.tv/*` uniquement, pas de wildcard TLD `[test]`
- [x] `content_scripts.run_at` justifié : **`document_start` volontaire**. La qualité et le
      volume se posent dans `localStorage` **avant** l'initialisation du lecteur Twitch ;
      en `document_idle` le lecteur démarre déjà en qualité source. `all_frames: false`. `[test]`
- [x] `web_accessible_resources` : exactement 4 fichiers (le module du script de contenu et
      les 3 modules qu'il importe), `matches` restreint à Twitch, `use_dynamic_url: true` `[test]`.
      `src/lib/quality.js` s'y est ajouté avec la qualité audio seul : module pur, aucune
      donnée, il ne fait que choisir une entrée de menu d'après des libellés
- [x] `externally_connectable` : absent `[test]`
- [x] CSP : aucune `content_security_policy` déclarée, donc celle par défaut de MV3 `[test]`
- [x] `default_locale: "fr"`, icônes 16/32/48/128 présentes `[test]`

### Code distant / injection
- [x] Aucun `eval`, `new Function`, `setTimeout(string)` `[test]`
- [x] Aucun `<script src=` externe `[test]`, aucun script inline `[test]`
- [x] Aucun fetch de JS exécuté ensuite. Le seul `import()` dynamique
      (`src/content/content.js`) pointe vers une ressource **du paquet**, résolue par
      `chrome.runtime.getURL` `[test]`
- [x] `innerHTML` / `insertAdjacentHTML` / `document.write` : **zéro occurrence** dans `src/` `[test]`
- [x] Les données venant de Twitch (noms de campagnes, de drops) sont posées en
      `textContent` uniquement, y compris dans le popup et la page d'options

---

## PASSE 2 : messaging, storage, données

### Messaging
- [x] `onMessage` valide `sender.id === chrome.runtime.id` `[test]`
- [x] Messages du script de contenu traités comme **non fiables** : `src/lib/message-guard.js`
      valide le type, la forme et les bornes de chaque champ avant traitement
      (`tests/message-guard.test.js`)
- [x] **Cloisonnement d'origine** : les messages qui pilotent l'extension
      (`set-settings`, `get-state`, `refresh-now`, `blacklist-campaign`) sont **refusés**
      s'ils viennent d'un onglet. Un Twitch compromis ne peut pas changer les réglages.
- [x] Un message d'onglet dont l'URL n'est pas `https://www.twitch.tv` est refusé
- [x] `onMessageExternal` : absent
- [x] Pas de dispatch dynamique sans allowlist : la table des types est parcourue avec
      `Object.hasOwn`, sinon `"constructor"` ou `"toString"` franchiraient l'allowlist
      via `Object.prototype` (trou trouvé et corrigé pendant cet audit)
- [x] `window.postMessage` : aucune occurrence. Le script de contenu ne parle jamais à la page.
- [x] Aucune donnée sensible envoyée à la page hôte : le script de contenu n'écrit rien
      dans le DOM de Twitch, il ne fait que lire et cliquer

### Storage
- [x] `chrome.storage.local` : aucun secret. **Le jeton Twitch n'y est jamais écrit.**
      Contenu : réglages, compteurs, liste d'actions, cache de campagnes, login Twitch,
      dernière erreur.
- [x] Les en-têtes repris de la page, qui contiennent le jeton de session et le jeton
      d'intégrité, vivent en **`chrome.storage.session`** : mémoire seulement, effacé à la
      fermeture de Chrome, jamais écrit sur le disque. C'est exactement la recommandation
      « tokens de session en `session` si possible ». Ils sont jetés dès que Twitch les
      refuse, ce qui force une nouvelle capture.
- [x] `session` contient par ailleurs les identifiants d'onglets et les battements de coeur.
- [x] Schéma versionné : `STORAGE_VERSION = 2` + `migrate()` appelée à l'installation et au
      démarrage. Migration écrite depuis la v1 (l'extension d'origine). `[test]`
- [x] Quota : toutes les écritures passent par `write()` qui attrape l'erreur, la journalise
      et la remonte dans l'interface via `lastError`. Pas de plantage silencieux.
- [x] Désinstallation : aucune donnée hors du navigateur, `chrome.storage` est purgé par
      Chrome. Pas d'`uninstall_url` (rien à nettoyer côté serveur).

### Données & réseau
- [x] **Inventaire des données collectées : aucune ne quitte la machine.** Détail dans
      `docs/PRIVACY.md`. Aucun serveur n'appartient au projet.
- [x] Tout fetch sortant : HTTPS, un seul domaine (`gql.twitch.tv`) `[test]`
- [x] **Une seule socket**, `wss://pubsub-edge.twitch.tv/v1`, le canal temps réel de Twitch.
      Chiffrée, et un test de régression vérifie qu'aucune autre adresse `ws://` ou `wss://`
      n'apparaît dans le code. Elle transporte le jeton de session dans sa trame
      d'abonnement : c'est le même jeton, vers le même émetteur, et il ne quitte jamais
      `chrome.storage.session`. Aucune donnée de l'utilisateur n'est envoyée, seulement
      un abonnement à ses propres évènements. Elle se coupe depuis les réglages.
- [x] Pas de télémétrie, même anonyme
- [x] `docs/PRIVACY.md` à jour
- [x] Pas de backend, donc N/A pour RLS et jetons courts
- [x] Le `Client-Id` présent dans `src/background/gql.js` est **l'identifiant public du client
      web Twitch**, visible dans n'importe quelle requête du site. Ce n'est pas un secret. `[test]`
      vérifie qu'aucune chaîne ressemblant à une clé privée n'est écrite en dur.
- [x] `OP_CURRENT_DROP.hash` (`src/background/gql.js`) est l'**empreinte publique d'une requête
      enregistrée chez Twitch** (`DropCurrentSessionContext`), celle que son propre site envoie.
      Ce n'est pas une clé : elle ne donne aucun accès, elle désigne une requête. Elle sert à
      appeler une opération dont on ne connaît pas la signature exacte, plutôt que d'en deviner
      une. Si Twitch la retire, l'API répond `PersistedQueryNotFound`, le code le reconnaît
      (`kind: "persisted"`), arrête d'appeler et retombe sur l'inventaire.

---

## PASSE 3 : supply chain, build, store

### Dépendances
- [x] **Zéro dépendance runtime**, extension vanilla, aucun `node_modules` dans le paquet
- [x] `npm audit --audit-level=high` : bloquant en CI
- [x] `package-lock.json` committé, `npm ci` en CI. Une seule devDependency,
      `@playwright/test`, version épinglée, jamais embarquée dans le paquet
- [x] Aucune dépendance qui ferait des requêtes réseau à l'exécution

### Build & release
- [x] `python scripts/build.py` construit `dist/` avec **uniquement** ce qui est livré
      (manifeste, `src/`, `_locales/`, `assets/`) puis `release/twitch-drops-claimer-vX.Y.Z.zip`
- [x] Le zip exclut `tests/`, `docs/`, `dev/`, `scripts/`, `.github/`, `package.json`, `CLAUDE.md`
- [x] Minification : **désactivée par défaut** (`--minify` pour l'activer). Un paquet lisible
      se relit à la main avant publication, ce qui est le vrai contrôle anti-supply-chain ici.
- [ ] Compte Chrome Web Store en 2FA : à faire au moment de la publication
- [ ] Diff review avant chaque publication : procédure à tenir, pas automatisable ici

### Comportement runtime
- [x] Service worker : aucun état critique en mémoire, tout passe par `chrome.storage`.
      Pas d'appel au chargement du module (sinon chaque réveil relancerait la mécanique).
- [x] Script de contenu : **n'injecte ni DOM ni CSS** dans la page → aucun préfixe nécessaire,
      aucune collision possible
- [x] Pas de `MutationObserver` : balayage périodique toutes les 8 s, borné, et qui ne fait
      que lire des attributs. Aucune dégradation mesurable de la page.
- [x] Navigation privée : l'extension est désactivée par défaut par Chrome ; si l'utilisateur
      l'autorise, `storage.local` est celui du profil normal, comportement inchangé
- [x] Erreurs attrapées : les messages remontés dans l'interface sont tronqués à 300
      caractères et ne contiennent ni jeton ni cookie

### Store review readiness
- [x] Description = ce que fait réellement l'extension
- [x] Justification de chaque permission rédigée (table ci-dessus, réutilisable telle quelle
      dans le formulaire du store)
- [ ] **Single purpose policy : point de vigilance.** L'extension fait deux choses proches
      (points de chaîne + drops) autour d'un même but « automatiser la récolte de récompenses
      Twitch ». Défendable, mais c'est le motif de rejet le plus probable.
- [ ] Screenshots + URL de politique de confidentialité : à préparer avant soumission
- [ ] **Risque produit, pas sécurité** : l'automatisation d'interactions est une zone grise
      vis-à-vis des CGU Twitch. À assumer explicitement dans la fiche du store.

---

## Grep rapides

```bash
grep -rn "eval\|new Function" src/
grep -rn "innerHTML\|insertAdjacentHTML\|document.write" src/
grep -rn "postMessage" src/
grep -rn "http://" src/ manifest.json
grep -rn "unsafe-" manifest.json
grep -rn "all_urls" manifest.json
```

Ces six greps sont doublés par `tests/extension.test.js`, qui échoue si l'un d'eux
remonte quelque chose.

## Historique des audits

| Date | Passe | Auditeur | Résultat |
|---|---|---|---|
| 03/08/2026 | 1, 2, 3 | Claude | 2 correctifs : permission `tabs` retirée (inutile), contournement de l'allowlist des messages via `Object.prototype` colmaté. Reste ouvert : `package-lock.json`, préparation store. |
