# Tester l'extension dans Chrome

Compte Twitch connecté obligatoire dans le même navigateur : l'extension réutilise ta
session pour interroger l'API. Sans ça, seuls les clics sur les onglets déjà ouverts
fonctionnent, et le popup affichera « Pas de session Twitch ».

---

## 1. Charger l'extension

```bash
python scripts/build.py
```

1. `chrome://extensions`
2. Activer **Mode développeur** (interrupteur en haut à droite)
3. **Charger l'extension non empaquetée** → choisir le dossier `dist/` du projet

Tu peux aussi charger le dossier racine directement, ça marche, mais `dist/` est ce qui
sera publié : autant tester exactement ça.

**Ce qui doit s'afficher tout de suite :**

- la carte de l'extension, sans bandeau rouge « Erreurs »
- **« Service worker »** en bleu cliquable sur la carte
- l'icône dans la barre d'outils, avec une pastille (grise si désactivé, sinon verte ou rouge)

Si un bandeau rouge apparaît, clique dessus : le message pointe la ligne exacte.

---

## 2. Les trois consoles

C'est le point qui perd le plus de monde : une extension a **trois contextes séparés**,
donc trois consoles différentes. Une erreur dans l'une n'apparaît jamais dans les autres.

| Ce que tu veux voir | Où regarder |
|---|---|
| Recherche de campagnes, alarmes, erreurs API Twitch | `chrome://extensions` → carte de l'extension → **Service worker** |
| Rendu du popup, clics sur les bascules | clic droit sur l'icône → **Inspecter le pop-up** |
| Clics de réclamation, état du lecteur | onglet Twitch → F12 → filtrer sur `[TDC]` |

Les messages du script de contenu sont en `console.debug`, il faut donc cocher
**Verbose** dans le filtre de niveau de la console, sinon tu ne verras rien.

---

## 3. Réglage minimum

Clic sur l'icône → **Réglages** (ou `chrome://extensions` → Détails → Options).

Mettre au moins une chaîne favorite, une par ligne. Un pseudo ou une URL complète,
les deux sont acceptés. **Enregistrer**.

Vérification immédiate : le champ se réécrit tout seul en pseudos minuscules
(`https://www.twitch.tv/ZeratoR` devient `zerator`). Si ça se produit, l'aller-retour
avec le service worker fonctionne.

---

## 4. Vérifier chaque fonction

### Points de chaîne et voyant vert/rouge

Dans la minute qui suit, un **onglet épinglé** doit apparaître sur ta chaîne favorite.

Ouvre le popup :

- voyant **vert** + « en train de regarder » → le temps de visionnage compte
- voyant **rouge** → survole la pastille, elle dit pourquoi (tableau du [README](../README.md))

Vérifie l'onglet lui-même : le lecteur tourne, le son est à 1 %, la qualité est en 160p
(roue crantée du lecteur). Si la qualité est restée en source, l'extension retentera
deux fois par le menu avant d'abandonner.

Le coffre violet de points de chaîne est cliqué automatiquement dans les 8 secondes qui
suivent son apparition. Le compteur « bonus de points » du popup monte de 1 et une
notification s'affiche.

> Le coffre n'apparaît qu'une fois toutes les 15 minutes environ. Pour ne pas attendre,
> regarde plutôt le compteur après une demi-heure de fonctionnement.

### Recherche de campagnes

Bouton **Rechercher** du popup : il force le cycle au lieu d'attendre les 30 minutes.

Après quelques secondes, la section **Campagnes suivies** doit se remplir : nom, jeu,
pourcentage, paliers, temps restant. Celle qui est encadrée en violet est celle en cours
de farm. Un **second onglet épinglé** s'ouvre sur une chaîne qui distribue ces drops.

Si la liste reste vide, regarde le bandeau rouge en haut du popup : il affiche l'erreur
exacte renvoyée par Twitch. Les deux cas courants :

- « Pas de session Twitch » → tu n'es pas connecté sur twitch.tv dans ce navigateur
- « Session Twitch refusée » → reconnecte-toi, le cookie a expiré

**Changer de chaîne** force le passage à la campagne suivante de la liste, utile pour
vérifier la rotation sans attendre qu'une campagne se termine.

### Réclamation des drops

Deux chemins, testables séparément.

**En direct** : quand un drop se termine pendant que tu regardes, Twitch affiche une
notification avec un bouton Réclamer. L'extension le clique dans les 8 secondes.

**Par l'inventaire** : c'est le chemin le plus simple à provoquer. Va sur
`twitch.tv/drops/inventory` : s'il y a quelque chose de réclamable, les boutons sont
cliqués tout seuls. Sinon, attends le passage automatique (15 min par défaut, réglable),
qui ouvre un onglet d'inventaire en arrière-plan et le recharge.

À chaque réclamation : compteur « drops réclamés » +1, notification système, et le nom
de la récompense sous les compteurs.

### Actions requises et cases à cocher

Cette section ne se remplit que si une de tes campagnes exige de lier ton compte chez
l'éditeur. Quand c'est le cas :

- la pastille de l'icône passe **orange** avec le nombre d'actions
- une notification s'affiche, avec deux boutons : **Ouvrir le site** et **C'est fait**
- la campagne apparaît dans **Actions requises** du popup avec une case à cocher

Coche la case (ou clique « C'est fait » dans la notification) : la ligne passe en vert
pâle, la pastille orange disparaît, et la campagne redevient éligible au farm même si
tu as activé « Ignorer les campagnes dont le compte n'est pas lié ».

Décocher remet l'action en attente : c'est réversible, aucune donnée n'est perdue.

---

## 5. Diagnostic quand un voyant reste rouge

| Message | Cause probable | Quoi faire |
|---|---|---|
| aucune réponse de l'onglet | Chrome a mis l'onglet en veille | `chrome://settings/performance` → ajouter `twitch.tv` aux sites à garder actifs |
| flux figé | le flux a planté sans mettre le lecteur en pause | recharger l'onglet, ou attendre le prochain cycle |
| chaîne hors ligne | la chaîne a coupé | normal, l'extension bascule au cycle suivant |
| onglet fermé | tu as fermé l'onglet épinglé | il se rouvre au cycle suivant, dans la minute |
| mauvaise chaîne chargée | une redirection Twitch | rare, se corrige au cycle suivant |

Dans la console du service worker, pour voir l'état brut :

```js
chrome.storage.local.get(null).then(console.log)      // réglages, compteurs, campagnes
chrome.storage.session.get("farmState").then(console.log)  // onglets et battements
chrome.alarms.getAll().then(console.log)              // les trois boucles
```

Les trois alarmes attendues sont `tdc-tick` (1 min), `tdc-discover` et `tdc-claim`.

---

## 6. Après une modification du code

```bash
python scripts/build.py
```

Puis, sur `chrome://extensions`, l'icône **recharger** (flèche circulaire) de la carte.

Attention : recharger l'extension **invalide les scripts de contenu déjà injectés**.
Les onglets Twitch ouverts affichent alors « Extension context invalidated » dans leur
console. C'est normal, ce n'est pas un bug : recharge les onglets Twitch concernés,
ou laisse l'extension les rouvrir au prochain cycle.

## 7. Repartir de zéro

Console du service worker :

```js
chrome.storage.local.clear(); chrome.storage.session.clear();
```

Puis recharge l'extension. Les réglages repartent aux valeurs par défaut, les compteurs
à zéro, la liste d'actions se vide. Le bouton **Valeurs par défaut** de la page de
réglages fait la même chose sans toucher aux compteurs.

---

## Ce que ce test ne couvre pas

Le comportement sur la durée, qui est le vrai juge : laisse tourner une soirée sur une
campagne réelle et compare le nombre de paliers obtenus à ce que Twitch affiche dans
`twitch.tv/drops/inventory`. Un écart signifie que le temps de visionnage n'est pas
comptabilisé comme prévu, et c'est le voyant qu'il faut alors surveiller.
