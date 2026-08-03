# Twitch Drops & Points Auto-Claimer

Extension Chrome (Manifest V3) qui fait quatre choses :

1. **Regarde une chaîne favorite en arrière-plan** et y réclame les bonus de points.
   Onglet épinglé, qualité 160p, son à 1 %, avec un **voyant vert / rouge** qui dit si
   le visionnage compte vraiment.
2. **Réclame les Twitch Drops** dès qu'un bouton apparaît, en direct comme dans
   l'inventaire, et repasse toutes les 15 minutes pour ramasser ce qui traîne.
3. **Cherche toute seule les campagnes en cours**, choisit une chaîne en direct qui
   distribue des drops, et enchaîne les campagnes jusqu'à les avoir toutes finies.
4. **Prévient quand il faut faire quelque chose hors de Twitch** (lier son compte chez
   l'éditeur, récupérer la récompense sur son site) et affiche une **liste à cocher**
   pour dire « c'est fait ».

## Installation

```bash
python scripts/build.py
```

Puis dans Chrome : `chrome://extensions` → **Mode développeur** → **Charger l'extension
non empaquetée** → choisir le dossier `dist/`.

Le dossier racine se charge aussi directement, mais `dist/` est ce qui sera publié.

## Réglage minimum

1. Être connecté sur `twitch.tv` dans le même navigateur.
2. Ouvrir les **Réglages** de l'extension, mettre au moins une chaîne favorite.
3. C'est tout. Le popup affiche l'état.

Pour vérifier fonction par fonction, lire les consoles et diagnostiquer un voyant rouge :
[docs/TESTER-DANS-CHROME.md](docs/TESTER-DANS-CHROME.md).

## Le voyant vert / rouge

Le script de contenu envoie un battement de coeur toutes les 5 secondes avec l'état réel
du lecteur. Le voyant est **vert** seulement si l'horloge de la vidéo avance vraiment.

| Voyant | Ce que ça veut dire |
|---|---|
| 🟢 en train de regarder | le temps de visionnage se cumule |
| 🟢 publicité en cours | normal, le temps continue de compter |
| 🔴 lecteur en pause / flux figé | le temps ne compte pas |
| 🔴 chaîne hors ligne | la chaîne a coupé, l'extension va en chercher une autre |
| 🔴 aucune réponse de l'onglet | onglet mis en veille par Chrome, ou script bloqué |
| 🔴 onglet fermé | l'onglet d'arrière-plan a été fermé à la main |

La pastille sur l'icône reprend le pire des deux voyants. Elle passe **orange avec un
chiffre** quand des actions vous attendent hors de Twitch.

## Pourquoi le son à 1 % et pas coupé

Chrome brime les minuteurs des onglets cachés **et silencieux** au bout de quelques
minutes : le lecteur continue, mais le comptage du temps se dérègle. Un onglet qui émet
du son, même à 1 %, échappe à ce bridage. C'est pour ça que le volume minimum est 1 et
pas 0. La qualité, elle, est descendue à 160p pour la bande passante.

## Ce qu'il faut savoir

- **Il faut être connecté à Twitch.** L'extension réutilise la session du navigateur pour
  interroger l'API GraphQL de Twitch (lecture seule). Elle ne demande jamais de mot de
  passe et n'écrit jamais le jeton de session sur le disque. Détail dans
  [docs/PRIVACY.md](docs/PRIVACY.md).
- **Twitch ne compte la progression que sur un flux à la fois.** L'onglet « points » et
  l'onglet « drops » cumulent tous les deux des points de chaîne, mais un seul fait
  avancer les drops.
- **Ne mettez pas les onglets d'arrière-plan en veille.** L'extension pose
  `autoDiscardable: false`, ce qui suffit dans la plupart des cas. Si un voyant reste au
  rouge en « aucune réponse de l'onglet », désactiver l'économiseur de mémoire pour
  `twitch.tv` dans `chrome://settings/performance`.
- **Le « mode rapide » est désactivé par défaut.** Activé, l'extension réclame les drops
  directement par l'API au lieu de simuler un clic. C'est plus fiable, mais c'est un choix
  à faire en connaissance de cause.
- **Zone grise vis-à-vis des CGU Twitch.** Automatiser des clics de réclamation n'est pas
  explicitement interdit, ce n'est pas non plus explicitement autorisé. À votre
  discrétion, sur votre compte.

## Développement

```bash
npm test                  # 91 tests unitaires et de régression, sans navigateur
npm run preview           # aperçu du popup et des réglages sur http://localhost:8791
npm run build             # dist/ + release/*.zip
npx playwright test       # e2e sur dist/ chargé dans Chromium
```

`npm run preview` sert `dev/popup-preview.html` et `dev/options-preview.html` : les vraies
vues, avec un bouchon de l'API `chrome` et des données factices. Pratique pour travailler
la mise en page sans recharger l'extension.

Les conventions du projet sont dans [CONTRIBUTING.md](CONTRIBUTING.md), l'audit de
sécurité dans [docs/AUDIT-SECU.md](docs/AUDIT-SECU.md), la politique de confidentialité
dans [docs/PRIVACY.md](docs/PRIVACY.md).

### Limite connue de l'environnement

Les tests e2e Playwright **ne tournent pas sur ce poste** : le Chromium téléchargé par
Playwright refuse de démarrer (« configuration côte-à-côte incorrecte », runtime Visual
C++ manquant sur la machine). Ils sont écrits et lancés par la CI GitHub, où le problème
ne se pose pas. Pour les faire tourner localement, installer le
*Microsoft Visual C++ Redistributable* puis relancer `npx playwright install chromium`.

## Si ça casse un jour

Twitch change son DOM régulièrement. Les points de rupture probables, dans l'ordre :

1. **Les boutons ne sont plus cliqués** → `src/lib/dom-rules.js`, ajouter le nouveau
   `data-test-selector` dans `DROP_CLAIM_SELECTORS`. Les tests de `tests/dom-rules.test.js`
   disent tout de suite si la règle devient trop permissive.
2. **La recherche de campagnes échoue** → `src/background/gql.js`, une requête a changé de
   forme. Le popup affiche l'erreur exacte remontée par Twitch.
3. **Le module du script de contenu ne se charge plus** → `use_dynamic_url: true` dans le
   manifeste est le premier suspect ; le passer à `false` pour vérifier.
