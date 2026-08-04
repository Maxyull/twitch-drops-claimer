# Politique de sécurité

## Signaler une faille

**Utilisez le signalement privé de GitHub** : onglet *Security* du dépôt →
*Report a vulnerability*. La discussion reste privée jusqu'au correctif.

N'ouvrez pas d'issue publique pour une faille : ce dépôt est public et une issue
l'est aussi.

Vous pouvez espérer une première réponse sous quelques jours. Ce projet est tenu
par une personne, sur son temps ; il n'y a ni astreinte ni prime.

## Ce que couvre cette extension

Il n'y a **ni serveur, ni compte, ni télémétrie**. Rien ne quitte la machine
(détail dans [`docs/PRIVACY.md`](docs/PRIVACY.md)). La surface d'attaque tient
en trois choses :

1. **Le jeton de session Twitch**, repris des en-têtes que la page envoie déjà.
   Il vit en `chrome.storage.session` : mémoire seulement, jamais écrit sur le
   disque. Il part vers `gql.twitch.tv` et `pubsub-edge.twitch.tv`, nulle part
   ailleurs.
2. **Les onglets ouverts en arrière-plan**, uniquement sur `www.twitch.tv`.
3. **Ce qui est stocké** : réglages, compteurs, journal des réclamations, cache
   de campagnes. Aucun secret.

Le raisonnement complet, passe par passe, est dans
[`docs/AUDIT-SECU.md`](docs/AUDIT-SECU.md).

## Ce qui nous intéresse vraiment

Par ordre de gravité, ce qui justifie un signalement privé :

- **Une fuite du jeton de session** hors de Twitch : une écriture sur le disque,
  un envoi vers un autre hôte, une exposition à une page web.
- **Une page qui parvient à faire agir l'extension.** Tous les messages passent
  par `src/lib/message-guard.js` : identité de l'émetteur, liste blanche de
  types, origine, bornes de chaque champ. Un contournement est une faille.
- **Une exécution de code venue d'ailleurs.** Il n'y a ni `eval`, ni
  `new Function`, ni CDN ; le seul `import()` dynamique vise une ressource du
  paquet. Tout chemin qui exécuterait autre chose est une faille.
- **Une injection par une donnée de Twitch.** Les noms de campagnes et de drops
  ne sont pas de confiance : ils sont posés en `textContent`. Tout endroit qui
  les ferait interpréter comme du HTML est une faille.
- **Une permission ou un hôte plus large que nécessaire**, ou un appel qui
  exigerait une permission non déclarée.

Chacun de ces points est figé par un test de régression dans
`tests/extension.test.js`. Si vous en cassez un, dites-le : le test est
probablement trop faible.

## Ce qui n'en est pas

Pour éviter les allers-retours :

- **Le `Client-Id` dans `src/background/gql.js`** est l'identifiant public du
  client web de Twitch, visible dans n'importe quelle requête du site. Ce n'est
  pas un secret.
- **L'empreinte `OP_CURRENT_DROP.hash`** désigne une requête enregistrée chez
  Twitch. Elle ne donne aucun accès et n'ouvre rien.
- **Le fait que l'extension automatise Twitch** est une question de conditions
  d'utilisation, pas de sécurité. Elle est posée franchement dans le
  [README](README.md) et l'utilisateur la tranche pour lui-même.
- **Une dépendance de développement vulnérable** qui ne part pas dans le paquet
  livré. Le zip n'embarque ni `node_modules`, ni `tests/`, ni `scripts/`.
- **Un rapport d'outil automatique sans chemin d'exploitation.** Dites ce qu'un
  attaquant obtient concrètement, sinon il n'y a rien à corriger.

## Versions suivies

Seule la dernière version publiée reçoit des correctifs. Le projet n'a pas de
branche de maintenance.

## Après un correctif

La correction part en PR publique avec, comme toute correction ici, le test qui
échoue sans elle. Le signalement est crédité dans la PR, sauf demande contraire.
