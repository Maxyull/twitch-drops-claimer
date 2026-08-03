# Politique de confidentialité

**Twitch Drops & Points Auto-Claimer**
Dernière mise à jour : 3 août 2026.

## En une phrase

L'extension ne collecte rien, n'envoie rien à personne, et n'a aucun serveur.
Tout ce qu'elle sait reste dans votre navigateur.

## Ce qui est stocké, et où

Tout est dans le stockage local de Chrome (`chrome.storage`), sur votre machine.

| Donnée | Zone | Pourquoi | Durée |
|---|---|---|---|
| Vos réglages (chaînes favorites, intervalles, qualité, volume) | `local` | Faire fonctionner l'extension comme vous l'avez demandé | Jusqu'à désinstallation |
| Compteurs de drops et de bonus réclamés | `local` | Affichage dans le popup | Jusqu'à désinstallation |
| Liste « actions requises » et leurs cases cochées | `local` | Ne pas vous re-signaler ce que vous avez déjà fait | Purge automatique 7 jours après avoir été cochée |
| Cache des campagnes de drops et de votre progression | `local` | Éviter de réinterroger Twitch en boucle | Rafraîchi en continu, détails purgés au bout de 24 h |
| Votre login Twitch | `local` | Nécessaire à une requête de l'API Twitch | Jusqu'à désinstallation |
| Identifiants des onglets ouverts par l'extension, état du lecteur | `session` | Voyant vert / rouge | Effacé à la fermeture de Chrome |

Désinstaller l'extension efface l'ensemble, Chrome s'en charge.

## Votre session Twitch

Pour interroger l'API de Twitch en votre nom, l'extension lit le cookie de session
`auth-token` du domaine `www.twitch.tv`, le même que celui qu'utilise le site quand
vous êtes connecté.

- Il est lu **au moment de la requête**, gardé dans une variable le temps de l'appel,
  et **jamais écrit dans le stockage**.
- Il n'est envoyé qu'à `https://gql.twitch.tv`, c'est-à-dire à Twitch lui-même.
- L'extension ne demande jamais votre mot de passe et ne touche à aucun formulaire
  de connexion.

## Ce qui sort de votre machine

Une seule destination : **`https://gql.twitch.tv`**, l'API officielle de Twitch.
Les requêtes envoyées sont : la liste de vos campagnes de drops, votre progression,
la liste des chaînes en direct, et, uniquement si vous activez le « mode rapide »,
la réclamation d'un drop.

Aucune autre destination. Pas d'analytics, pas de serveur du développeur, pas de
télémétrie, même anonyme. Il n'y a pas d'option à désactiver parce qu'il n'y a rien
à désactiver.

## Ce que l'extension ne fait pas

- Elle ne lit pas votre historique de navigation.
- Elle n'agit que sur `www.twitch.tv` : aucun autre site n'est accessible pour elle.
- Elle ne lit pas vos messages, vos e-mails, vos identifiants.
- Elle ne partage, ne vend et ne transmet aucune donnée à un tiers.

## RGPD

Aucun traitement de données personnelles au sens du RGPD n'a lieu côté développeur :
il n'existe aucun serveur, aucune base, aucun destinataire. Les données citées plus
haut sont sous votre seul contrôle, sur votre machine, et vous les effacez en
désinstallant l'extension ou en vidant son stockage depuis `chrome://extensions`.

## Contact

Une question ou un doute sur ce document : ouvrir une issue sur le dépôt du projet.
