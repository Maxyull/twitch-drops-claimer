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

## Les chaînes regardées, et si elles comptent

Le popup liste chaque onglet que l'extension fait tourner en arrière-plan : la chaîne,
ce qu'elle sert à farmer, depuis combien de temps, et surtout **si Twitch la
comptabilise**. Un clic sur une ligne affiche l'onglet correspondant.

Le comptage n'est pas déduit, il est observé. L'extension écoute deux signaux réseau,
sans jamais les bloquer ni les modifier :

| Badge | Ce qui a été observé |
|---|---|
| 🟢 compté en viewer | le ping de comptage du lecteur Twitch, preuve directe |
| 🟠 flux téléchargé | les segments vidéo arrivent, mais aucun ping vu (bloqueur de pub ?) |
| 🔴 non compté | plus rien depuis trop longtemps, ou lecteur à l'arrêt |
| ⚪ en cours de vérification | l'onglet vient d'ouvrir, trop tôt pour se prononcer |

L'état orange existe parce qu'un bloqueur de publicité peut tuer le ping sans empêcher
le comptage : répondre « non » dans ce cas serait un mensonge.

## Le voyant vert / rouge

Le script de contenu envoie un battement de coeur toutes les 5 secondes avec l'état réel
du lecteur. Le voyant est **vert** seulement si l'horloge de la vidéo avance vraiment.

| Voyant | Ce que ça veut dire |
|---|---|
| 🟢 en train de regarder | le temps de visionnage se cumule |
| 🟢 publicité en cours | normal, le temps continue de compter |
| 🔴 lecture refusée par le navigateur | lecteur non coupé dans un onglet d arrière-plan |
| 🔴 lecteur en pause / flux figé | le temps ne compte pas |
| 🔴 chaîne hors ligne | la chaîne a coupé, l'extension va en chercher une autre |
| 🔴 aucune réponse de l'onglet | onglet mis en veille par Chrome, ou script bloqué |
| 🔴 onglet fermé | l'onglet d'arrière-plan a été fermé à la main |

La pastille sur l'icône reprend le pire des deux voyants. Elle passe **orange avec un
chiffre** quand des actions vous attendent hors de Twitch.

## Pourquoi les onglets sont en sourdine

Ce n'est pas qu'un confort : **Chrome refuse de lancer une vidéo avec du son dans un
onglet d'arrière-plan** sans geste préalable de l'utilisateur. Un lecteur non coupé ne
démarre donc jamais, et rien n'est comptabilisé. La lecture en sourdine, elle, est
toujours autorisée.

Le réglage se désactive si vous y tenez, mais attendez-vous alors à voir le voyant
« lecture refusée par le navigateur ». Dans ce cas l'extension active brièvement
l'onglet pour débloquer le lecteur, au plus une fois toutes les trois minutes.

La sourdine est posée deux fois : sur le lecteur par le script de contenu, et sur
l'onglet lui-même. Si le script de contenu ne se charge pas, Twitch démarre au volume
que vous aviez enregistré et l'onglet se met à parler tout seul ; la sourdine d'onglet
couvre ce cas.

L'extension garde par défaut **une fenêtre réduite à elle** pour ses onglets. C'est ce
qui lui permet de faire ce réveil sans jamais voler le focus de la fenêtre où vous
travaillez. Elle y avance d'un onglet à chaque passage, pour que chacun ait son tour au
premier plan, ce qui suffit à relancer un lecteur que le navigateur avait mis de côté.

**Elle rend toujours la place.** Un onglet activé le reste cinq secondes, le temps que
le lecteur démarre, puis celui qui était devant revient. Une extension qui confisque
l'onglet qu'on regardait ne vaut pas le gain. Un clic sur une ligne de la liste affiche
l'onglet correspondant si vous voulez y aller vous-même, et là il y reste.

La qualité est descendue à 160p pour la bande passante.

## Ce qu'il faut savoir

- **Il faut être connecté à Twitch, et garder un onglet Twitch ouvert.** L'API de Twitch
  exige un jeton d'intégrité que son propre JavaScript calcule dans la page ; une
  extension ne peut pas le fabriquer. L'extension reprend donc au passage les en-têtes
  que la page envoie déjà. Sans onglet Twitch, le popup affiche « en attente d'un onglet
  Twitch » et en ouvre un tout seul. Détail dans [docs/PRIVACY.md](docs/PRIVACY.md).
- **Plusieurs onglets de farm, mais Twitch n'en compte probablement qu'un.** Le réglage
  ouvre deux onglets par défaut, sur deux campagnes et deux chaînes différentes. Personne
  ne garantit que Twitch fasse avancer les deux : c'est justement pour ça que chaque ligne
  du popup porte son propre badge de comptage. Regardez-les plutôt que de me croire.
- **Les onglets se ferment tout seuls quand ils ne servent plus.** Aucune chaîne favorite
  en direct, plus aucune campagne à farmer, inventaire déjà passé : l'onglet disparaît.
  Le seul cas où l'inventaire est conservé est quand c'est le dernier onglet Twitch, car
  il sert alors aussi à reprendre le jeton d'intégrité.
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
2. **« failed integrity check »** → le jeton repris de la page a expiré ou Twitch a changé
   le nom de ses en-têtes. Voir `FORWARDED_HEADERS` dans `src/lib/gql-headers.js` et
   comparer avec une vraie requête (F12 sur un onglet Twitch, onglet Network, filtre `gql`,
   section Request Headers).
3. **La recherche de campagnes échoue autrement** → `src/background/gql.js`, une requête a
   changé de forme. Le popup affiche l'erreur exacte remontée par Twitch.
4. **Le module du script de contenu ne se charge plus** → `use_dynamic_url: true` dans le
   manifeste est le premier suspect ; le passer à `false` pour vérifier.
