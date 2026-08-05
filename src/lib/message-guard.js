// Validation of incoming messages.
// Two principles, taken from docs/SECURITY-AUDIT.md:
//  1. a message from a content script is NEVER trusted (the page may be
//     compromised): type, shape and bounds are validated before any processing;
//  2. no dynamic dispatch: only allowlisted types get through, and each one is
//     accepted only from the origin entitled to send it.
// Pure module: the sender's identity check is passed in as a parameter.
//
// A rejection carries two things: `error`, an English string for the service
// worker's console, and `reason`, a catalogue key for the popup. They are
// separate because they have different readers (#76).

import { MSG, MESSAGE_ORIGIN, SENDER, CLAIM_KIND, CAMPAIGN_PRIORITY } from "./messaging.js";
import { normalizeChannel, DEFAULT_SETTINGS } from "./settings.js";
import { ERROR } from "./errors.js";

const MAX_TEXT = 200;

function text(value, max = MAX_TEXT) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function bool(value) {
  return value === true;
}

function number(value, { min = -Infinity, max = Infinity, fallback = 0 } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Sanitisers per message type. Return the cleaned payload, or null when invalid. */
const SANITIZERS = {
  [MSG.HELLO]: (p) => ({ url: text(p?.url, 500) }),

  [MSG.BEAT]: (p) => {
    if (!isPlainObject(p)) return null;
    return {
      channel: normalizeChannel(p.channel) || null,
      url: text(p.url, 500),
      role: text(p.role, 20),
      paused: bool(p.paused),
      blocked: bool(p.blocked),
      ads: bool(p.ads),
      offline: bool(p.offline),
      currentTime: number(p.currentTime, { min: 0, max: 1e9 }),
      videoHeight: number(p.videoHeight, { min: 0, max: 10_000 }),
    };
  },

  [MSG.CLAIMED]: (p) => {
    if (!isPlainObject(p)) return null;
    const kind = p.kind === CLAIM_KIND.POINTS ? CLAIM_KIND.POINTS : CLAIM_KIND.DROP;
    return {
      kind,
      label: text(p.label, 120),
      dropName: text(p.dropName, 120),
      campaignId: text(p.campaignId, 80),
      channel: normalizeChannel(p.channel) || null,
    };
  },

  [MSG.INVENTORY_DONE]: (p) => ({ claimed: number(p?.claimed, { min: 0, max: 500 }) }),

  [MSG.GET_STATE]: () => ({}),
  [MSG.REFRESH_NOW]: () => ({}),
  [MSG.SWITCH_NOW]: () => ({}),
  [MSG.REBUILD_WINDOW]: () => ({}),

  [MSG.SET_SETTINGS]: (p) => {
    if (!isPlainObject(p)) return null;
    // Strict allowlist: an unknown key is dropped, never carried into storage.
    const out = {};
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (key in p) out[key] = p[key];
    }
    return Object.keys(out).length ? out : null;
  },

  [MSG.SET_ACTION_DONE]: (p) => {
    const id = text(p?.id, 200);
    if (!id) return null;
    return { id, done: p.done !== false };
  },

  [MSG.SET_CAMPAIGN_PRIORITY]: (p) => {
    const id = text(p?.id, 80);
    const priority = Object.values(CAMPAIGN_PRIORITY).includes(p?.priority) ? p.priority : null;
    if (!id || !priority) return null;
    return { id, priority };
  },
};

/**
 * @param {any} msg
 * @param {object} sender  the `sender` object from chrome.runtime.onMessage
 * @param {string} extensionId  chrome.runtime.id
 * @returns {{ok:true,type:string,payload:object}|{ok:false,error:string,reason:string}}
 */
export function validateMessage(msg, sender, extensionId) {
  // Another extension does not get to talk here.
  if (!sender || sender.id !== extensionId) return { ok: false, error: "unknown sender", reason: ERROR.SENDER };

  // `hasOwn` rather than a plain read: without it, "constructor" or "toString"
  // come up from Object.prototype and clear the allowlist.
  const type = typeof msg?.type === "string" ? msg.type : "";
  if (!Object.hasOwn(MESSAGE_ORIGIN, type) || !Object.hasOwn(SANITIZERS, type)) {
    return { ok: false, error: "message type refused", reason: ERROR.MESSAGE_TYPE };
  }
  const origin = MESSAGE_ORIGIN[type];

  // The decision rests on the sender's URL, not on `sender.tab` being present:
  // the options page is a tab too, so it has a `sender.tab` as well.
  if (origin === SENDER.PRIVILEGED) {
    if (!isExtensionUrl(sender.url, extensionId)) {
      return { ok: false, error: "a web page cannot drive the extension", reason: ERROR.NOT_PRIVILEGED };
    }
  } else if (!isTwitchUrl(sender.url) || !sender.tab) {
    return { ok: false, error: "message expected from a Twitch tab", reason: ERROR.NOT_TWITCH };
  }

  const payload = SANITIZERS[type](msg.payload);
  if (payload === null) return { ok: false, error: "invalid payload", reason: ERROR.PAYLOAD };

  return { ok: true, type, payload };
}

/** A page of the extension itself: popup, options page. */
export function isExtensionUrl(url, extensionId) {
  return typeof url === "string" && Boolean(extensionId)
    ? url.startsWith(`chrome-extension://${extensionId}/`)
    : false;
}

export function isTwitchUrl(url) {
  if (typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "www.twitch.tv";
  } catch {
    return false;
  }
}
