// Message types. No magic string anywhere else in the code.
// This module imports nothing: it is exposed to the content script, so we keep
// its surface minimal (see docs/SECURITY-AUDIT.md, web_accessible_resources).

export const MSG = {
  // content script -> service worker
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
  SET_CAMPAIGN_PRIORITY: "set-campaign-priority",
  REBUILD_WINDOW: "rebuild-window",
};

/** A campaign's place in the rotation, chosen by the user. */
export const CAMPAIGN_PRIORITY = {
  FOCUS: "focus", // handled before the others
  NORMAL: "normal",
  IGNORE: "ignore", // out of the rotation
};

/** Who is allowed to send what. */
export const SENDER = {
  CONTENT: "content", // Twitch tab: never trusted, the page can be compromised
  PRIVILEGED: "privileged", // popup / options page: extension context
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
  [MSG.SET_CAMPAIGN_PRIORITY]: SENDER.PRIVILEGED,
  [MSG.REBUILD_WINDOW]: SENDER.PRIVILEGED,
};

export const CLAIM_KIND = { POINTS: "points", DROP: "drop" };

export const ROLE = {
  POINTS: "points", // tab opened by the extension for channel points
  DROPS: "drops", // tab opened by the extension to farm a campaign
  INVENTORY: "inventory", // the /drops/inventory tab
  PASSIVE: "passive", // tab opened by the user: we never touch its player
};
