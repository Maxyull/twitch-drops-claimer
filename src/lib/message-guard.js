// Validation des messages entrants.
// Deux principes, tirés de docs/AUDIT-SECU.md :
//  1. un message d'un script de contenu n'est JAMAIS de confiance (la page peut
//     être compromise) : on valide type, forme et bornes avant tout traitement ;
//  2. pas de dispatch dynamique : seuls les types de l'allowlist passent, et
//     chacun n'est accepté que depuis l'origine qui a le droit de l'envoyer.
// Module pur : le contrôle d'identité de l'expéditeur est passé en paramètre.

import { MSG, MESSAGE_ORIGIN, SENDER, CLAIM_KIND, CAMPAIGN_PRIORITY } from "./messaging.js";
import { normalizeChannel, DEFAULT_SETTINGS } from "./settings.js";

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

/** Nettoyeurs par type de message. Renvoient la charge utile assainie, ou null si invalide. */
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
    // Allowlist stricte : une clé inconnue est jetée, pas propagée au stockage.
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
 * @param {object} sender  l'objet `sender` de chrome.runtime.onMessage
 * @param {string} extensionId  chrome.runtime.id
 * @returns {{ok:true,type:string,payload:object}|{ok:false,error:string}}
 */
export function validateMessage(msg, sender, extensionId) {
  // Un autre module d'extension ne parle pas ici.
  if (!sender || sender.id !== extensionId) return { ok: false, error: "expéditeur inconnu" };

  // `hasOwn` et pas une simple lecture : sans ça, "constructor" ou "toString"
  // remontent depuis Object.prototype et franchissent l'allowlist.
  const type = typeof msg?.type === "string" ? msg.type : "";
  if (!Object.hasOwn(MESSAGE_ORIGIN, type) || !Object.hasOwn(SANITIZERS, type)) {
    return { ok: false, error: "type de message refusé" };
  }
  const origin = MESSAGE_ORIGIN[type];

  // On tranche sur l'URL de l'expéditeur, pas sur la présence de `sender.tab` :
  // la page d'options est elle aussi un onglet, elle a donc un `sender.tab`.
  if (origin === SENDER.PRIVILEGED) {
    if (!isExtensionUrl(sender.url, extensionId)) {
      return { ok: false, error: "une page web ne peut pas piloter l'extension" };
    }
  } else if (!isTwitchUrl(sender.url) || !sender.tab) {
    return { ok: false, error: "message attendu depuis un onglet Twitch" };
  }

  const payload = SANITIZERS[type](msg.payload);
  if (payload === null) return { ok: false, error: "charge utile invalide" };

  return { ok: true, type, payload };
}

/** Page de l'extension elle-même : popup, page d'options. */
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
