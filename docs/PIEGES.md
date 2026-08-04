# Les pièges, et pourquoi le code est écrit comme ça

Ce fichier existe parce que chacune de ces lignes a coûté un bug, souvent
plusieurs allers-retours, et qu'aucune ne se devine en lisant le code. Chaque
entrée dit **le piège**, **ce qu'on croyait**, et **ce qui est vrai**.

Les issues citées gardent le détail, dont les hypothèses écartées.

---

## Chrome

### La lecture automatique avec du son est refusée en arrière-plan

Un onglet d'arrière-plan ne démarre **jamais** une vidéo non coupée : Chrome
refuse `play()` sans geste préalable de l'utilisateur, avec `NotAllowedError`.

La sourdine n'est donc pas un confort, c'est ce qui fait fonctionner le farm.
Le réglage se désactive, mais le voyant passe alors à « lecture refusée par le
navigateur ». Voir [#6](../../../issues/6).

Corollaire : la sourdine est posée **deux fois**, sur le lecteur par le script de
contenu, et sur l'onglet lui-même. Si le script ne se charge pas, Twitch démarre
au volume enregistré par l'utilisateur et l'onglet se met à parler tout seul.

### `chrome.storage.session` est vidé à chaque rechargement de l'extension

Pas seulement à la fermeture du navigateur. Tout ce qui doit survivre à un
`chrome://extensions` → recharger appartient à `local`.

Trois fenêtres en trop ont eu cette seule cause, corrigées trois fois de travers
avant qu'elle soit vue. Voir [#42](../../../issues/42), et [#31](../../../issues/31),
[#36](../../../issues/36), [#40](../../../issues/40) pour les rustines qui l'ont
précédée.

La répartition est explicite dans `src/lib/storage.js` :
`PERSISTENT_STATE_KEYS` d'un côté, le reste en session.

### Ce qui ne demande PAS la permission `tabs`

- `chrome.tabs.create` / `update` / `remove` / `get` / `reload`
- `chrome.tabs.update(id, { muted })`
- `chrome.tabs.query` **filtré par une URL couverte par `host_permissions`**
- `chrome.tabs.query({ active: true, windowId })`, dont on ne lit que l'identifiant

Ce qui la demanderait : lire `url`, `title` ou `favIconUrl` d'un onglet hors du
périmètre d'hôte. Des tests de régression figent ces limites, et ils ont été
**resserrés** à chaque fois qu'un nouvel appel apparaissait, jamais assouplis.

### `windows.create({ state, focused })`

Les deux propriétés se recouvrent. La fenêtre est créée non focalisée, puis
réduite, en deux temps.

---

## Twitch

### L'API GraphQL exige un jeton d'intégrité qu'on ne peut pas fabriquer

Sans en-tête `Client-Integrity`, toute requête reçoit `failed integrity check`.
Ce jeton est calculé par le JavaScript de Twitch, dans la page.

L'extension reprend donc les en-têtes que la page envoie déjà, listés
explicitement dans `src/lib/gql-headers.js`. Conséquence assumée : **elle a
besoin d'au moins un onglet Twitch ouvert** pour interroger l'API.

Effet de bord heureux : l'autorisation vient du même endroit, donc la permission
`cookies` a pu être retirée. Voir [#25](../../../issues/25) et l'audit.

### Twitch réécrit l'URL en permanence

C'est une application monopage : le fragment `#tdc` qui marque les onglets de
l'extension disparaît à chaque navigation interne. Le script de contenu le
remet, mais **seulement tant qu'il est vivant**. Après un rechargement de
l'extension, plus personne ne le remet.

Ce marqueur est donc un filet de secours, jamais la source de vérité.

### Une page Twitch contient plusieurs `<video>`

Aperçus de la barre latérale, bandeau de recommandation, publicité.
`querySelector("video")` renvoie le premier venu, souvent à l'arrêt, et tout le
diagnostic part de là. On prend celui qui joue, à défaut le plus grand.
Voir [#16](../../../issues/16).

Le tri initial exigeait aussi `videoWidth > 0`, ce qui semblait inoffensif : un
lecteur sans image n'est pas un lecteur. **Sauf en qualité audio seul**, où le
flux légitime n'a précisément aucune image et se faisait donc écarter. Le
critère est retombé à `!paused && readyState >= 2`, qui suffisait déjà à écarter
les aperçus à l'arrêt, le vrai problème d'origine.

### La dernière entrée du menu qualité est « Audio Only »

Descendre la qualité en cliquant la dernière entrée du menu paraît évident.
L'ordre réel est : Auto, Source, 720p60, ..., 160p, **Audio Only**. Le repli
« qualité la plus basse » coupait donc l'image sur les chaînes qui proposent
l'audio seul, sans que personne l'ait demandé, et faisait perdre le bon `<video>`
au piège ci-dessus.

Le choix se fait maintenant sur le libellé, dans `src/lib/quality.js` : module
pur, testé sur les menus réels en français et en anglais. Le mot « audio » n'est
porté par aucune autre entrée, et surtout pas par « Auto ».

### `community-points-summary` n'est pas le coffre

C'est le conteneur du **solde**, toujours présent à côté du chat. S'en contenter
revenait à cliquer le solde, à ouvrir le menu des points, et à ne jamais
atteindre le coffre, tout en rapportant une réclamation qui n'avait pas eu lieu.

Le vrai marqueur, `claimable-bonus`, est porté par une icône **à l'intérieur** du
bouton : il faut donc lire les marqueurs des enfants, pas seulement des ancêtres.
Voir [#12](../../../issues/12).

Depuis, le bonus est réclamé par l'API, qui dit explicitement qu'un coffre attend
et confirme qu'il a été pris. Le clic reste en secours pour les onglets que
l'utilisateur ouvre lui-même. Attention alors au double comptage : la
déduplication est à deux niveaux dans `farm.js`.

### Un cache ne doit jamais porter la progression

Le cache de structure des campagnes servait aussi `isClaimed`, vieux de six
heures. Un drop réclamé entre-temps restait invisible, et le compteur ne bougeait
pas. La structure se met en cache, l'avancement vient de l'inventaire.
Voir [#27](../../../issues/27).

### Twitch ne fait probablement progresser qu'un flux à la fois

**Probablement.** Personne ne le garantit, et l'extension ne tranche pas à sa
place : elle ouvre plusieurs onglets de farm si on le lui demande, et le badge
« compté en viewer » de chaque ligne dit lequel avance vraiment.

---

## Principes tirés de ces bugs

### Une preuve l'emporte toujours sur une déduction

L'état du lecteur lu dans le DOM est une déduction, et elle s'est trompée. Les
segments vidéo téléchargés, les pings de comptage et la progression relevée dans
l'inventaire sont des faits. `evaluateCounted` regarde les preuves **avant** de
juger l'état du lecteur, dans cet ordre précis. Voir [#16](../../../issues/16).

### Un compteur compte ce qui s'est passé, pas ce qu'on a fait

Le compteur de drops suivait nos clics. Twitch peut créditer un palier sans nous,
un clic peut échouer sans bruit, un message peut ne pas arriver. Il compte
désormais les paliers marqués obtenus par Twitch, dédupliqués par identifiant.

Avec une précaution : le premier passage ne compte rien, il prend une empreinte
de l'existant. Sinon le compteur sauterait de 0 à tout l'historique du compte.
Voir [#14](../../../issues/14).

### Ne jamais conclure sur une information qu'on n'a pas

`liveLogins` peut échouer. Une liste vide et une absence de réponse ne veulent
pas dire la même chose : confondre les deux ferme les onglets à chaque hoquet de
l'API. Le code distingue explicitement `null` de `[]`.

Même logique pour `isAccountConnected` : `null` veut dire « la requête ne portait
pas l'information », pas « compte non lié ».

### Une confirmation qui ment coûte des heures

La page de réglages affichait « Enregistré » sans regarder la réponse. Un refus
était indiscernable d'une réussite, et c'est ce qui a rendu un bug invisible
pendant trois PR. Voir [#3](../../../issues/3) et [#35](../../../issues/35).

Pire cas trouvé : elle laissait aussi **enregistrer avant d'avoir lu**, donc le
formulaire vide s'écrivait par-dessus les vrais réglages. Les boutons sont
maintenant inactifs jusqu'à la lecture réussie.

### Vérifier avant d'affirmer

Deux fois ici, la cause évidente était fausse : une collision d'écritures dans
`storage.session` (infirmée par une sonde jetable), et la permission `tabs`
supposée nécessaire pour couper le son d'un onglet. Une sonde coûte deux minutes.

Les hypothèses écartées restent écrites dans les issues : savoir ce qui n'était
**pas** la cause fait gagner du temps à la panne suivante.

### La CI a raison jusqu'à preuve du contraire

Elle a trouvé, seule, le rejet des messages de la page d'options, l'enregistrement
bloqué par l'ouverture des onglets, et l'écrasement des réglages par un
formulaire vide. Une CI intermittente est pire qu'une CI absente : elle apprend à
ignorer le rouge.

---

## Limite de l'environnement de développement

Les tests e2e Playwright **ne tournent pas sur le poste de développement** : le
Chromium téléchargé refuse de démarrer, faute du *Visual C++ Redistributable*.
Ils sont écrits et exécutés par la CI. Ne pas promettre de les avoir lancés en
local.

La vérification locale du rendu passe par `npm run preview`, qui sert les vraies
vues avec un bouchon de l'API `chrome`. Sauter cette étape a produit une page de
réglages illisible ([#21](../../../issues/21)).
