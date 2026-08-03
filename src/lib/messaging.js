// Types de messages. Aucune chaîne magique ailleurs dans le code.
// Ce module n'importe rien : il est exposé au script de contenu, on garde sa
// surface minimale (cf. docs/AUDIT-SECU.md, web_accessible_resources).

export const MSG = {
  // script de contenu -> service worker
  HELLO: "hello",
  BEAT: "beat",
  CLAIMED: "claimed",
  INVENTORY_DONE: "inventory-done",

  // popup / options -> service worker
  GET_STATE: "get-state",
  SET_SETTINGS: "set-settings",
  SET_ACTION_DONE: "set-action-done",
  REFRESH_NOW: "refresh-now",
  SWITCH_NOW: "switch-now",
  BLACKLIST_CAMPAIGN: "blacklist-campaign",
};

/** Qui a le droit d'envoyer quoi. */
export const SENDER = {
  CONTENT: "content", // onglet Twitch : jamais de confiance, la page peut être compromise
  PRIVILEGED: "privileged", // popup / page d'options : contexte de l'extension
};

export const MESSAGE_ORIGIN = {
  [MSG.HELLO]: SENDER.CONTENT,
  [MSG.BEAT]: SENDER.CONTENT,
  [MSG.CLAIMED]: SENDER.CONTENT,
  [MSG.INVENTORY_DONE]: SENDER.CONTENT,

  [MSG.GET_STATE]: SENDER.PRIVILEGED,
  [MSG.SET_SETTINGS]: SENDER.PRIVILEGED,
  [MSG.SET_ACTION_DONE]: SENDER.PRIVILEGED,
  [MSG.REFRESH_NOW]: SENDER.PRIVILEGED,
  [MSG.SWITCH_NOW]: SENDER.PRIVILEGED,
  [MSG.BLACKLIST_CAMPAIGN]: SENDER.PRIVILEGED,
};

export const CLAIM_KIND = { POINTS: "points", DROP: "drop" };

export const ROLE = {
  POINTS: "points", // onglet ouvert par l'extension pour les points de chaîne
  DROPS: "drops", // onglet ouvert par l'extension pour farmer une campagne
  INVENTORY: "inventory", // onglet /drops/inventory
  PASSIVE: "passive", // onglet ouvert par l'utilisateur : on n'y touche pas au lecteur
};
