# À vérifier à la main

**La liste vit dans l'issue épinglée [#56](../../../issues/56), pas ici.**

Elle y est cochable directement, et les échecs s'y commentent : c'est ce qui
permet de suivre ce qui reste à faire et ce qui est cassé. Recopier la liste
dans ce fichier créerait une seconde vérité qui divergerait au premier
décochage.

## Pourquoi une liste manuelle existe

L'API de Twitch exige un jeton d'intégrité que seul son propre JavaScript sait
calculer, dans une page ouverte. Aucun test automatique ne peut l'obtenir. Tout
ce qui touche au réseau réel, au lecteur, aux notifications ou au comportement
de Twitch se vérifie donc à la main, une fois, sur un vrai compte.

S'y ajoute ce qui vient d'ailleurs et qu'on ne peut pas exécuter en CI :
l'empreinte de `DropCurrentSessionContext`, la mutation `JoinRaid`, les trames
`raid_update_v2`. Les modules purs qui les entourent sont testés ; le format du
fil, lui, ne se prouve que sur une vraie session.

## Règle de contribution

**Toute PR qui ajoute un comportement que la CI ne peut pas prouver ajoute sa
section à l'issue [#56](../../../issues/56), avec son numéro de PR, avant le
merge.**

Une section suit toujours la même forme :

- ce qu'il faut faire, précisément, et combien de temps attendre ;
- ce qui prouve que ça marche, observable, pas déductible ;
- ce que ça donne si c'est cassé, et quoi copier en commentaire.

Un test qu'on ne saurait pas rater n'est pas un test. « Vérifier que ça marche »
n'en est pas un non plus.

## Ce qui n'y va pas

Ce que la CI couvre déjà : la logique des modules `src/lib/`, les permissions du
manifeste, les clés i18n, les sorties réseau autorisées, les invariants figés
par les tests de régression. Une régression y échouerait avant d'arriver entre
les mains de qui que ce soit.
