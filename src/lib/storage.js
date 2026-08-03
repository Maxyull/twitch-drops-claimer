// Unique porte d'entrée du stockage : valeurs par défaut, schéma versionné,
// migration à la mise à jour, quota géré.
//   - `local`   : réglages, compteurs, actions à cocher, cache de campagnes.
//   - `session` : état volatil (onglets, battements), le service worker meurt souvent.
// Rien de sensible n'y est écrit : pas de jeton, pas de mot de passe
// (cf. docs/AUDIT-SECU.md, passe 2).

import { DEFAULT_SETTINGS, normalizeSettings } from "./settings.js";

export const STORAGE_VERSION = 2;

export const DEFAULT_STATS = { drops: 0, points: 0, lastClaim: null, lastClaimLabel: "" };

/** Écriture tolérante au quota : on n'explose pas la boucle pour un stockage plein. */
async function write(area, values) {
  try {
    await chrome.storage[area].set(values);
    return { ok: true };
  } catch (err) {
    const message = err?.message ?? String(err);
    console.warn("[TDC] écriture", area, "refusée :", message);
    if (area !== "local") return { ok: false, error: message };
    try {
      await chrome.storage.local.set({
        lastError: { message: `Stockage : ${message}`, at: Date.now() },
      });
    } catch {
      /* stockage vraiment mort, on abandonne en silence */
    }
    return { ok: false, error: message };
  }
}

// --- migration ------------------------------------------------------------

/**
 * v1 (extension d'origine) : { enabled, claimPoints, stats }.
 * v2 : réglages complets + actions à cocher + cache de campagnes.
 */
export async function migrate() {
  const { storageVersion = 1, ...rest } = await chrome.storage.local.get(null);
  if (storageVersion === STORAGE_VERSION) return storageVersion;

  // Fusion, jamais remise à zéro : tout réglage déjà présent et valide survit,
  // `normalizeSettings` se charge d'écarter ce qui ne l'est pas et de combler
  // les manques. Énumérer les clés à conserver ferait perdre en silence celles
  // qu'on oublie, et cette perte se rejouerait à chaque rechargement tant que
  // `storageVersion` n'est pas écrit.
  const migrated = normalizeSettings({ ...DEFAULT_SETTINGS, ...rest });

  await write("local", {
    ...migrated,
    stats: { ...DEFAULT_STATS, ...(rest.stats ?? {}) },
    actions: Array.isArray(rest.actions) ? rest.actions : [],
    storageVersion: STORAGE_VERSION,
  });
  return STORAGE_VERSION;
}

// --- réglages -------------------------------------------------------------

export async function getSettings() {
  const raw = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return normalizeSettings(raw);
}

export async function setSettings(patch) {
  const merged = normalizeSettings({ ...(await getSettings()), ...patch });
  await write("local", merged);
  return merged;
}

// --- compteurs ------------------------------------------------------------

export async function getStats() {
  const { stats = DEFAULT_STATS } = await chrome.storage.local.get("stats");
  return { ...DEFAULT_STATS, ...stats };
}

export async function bumpStat(kind, label = "", amount = 1) {
  const stats = await getStats();
  if (kind === "drops" || kind === "points") stats[kind] += amount;
  stats.lastClaim = Date.now();
  if (label) stats.lastClaimLabel = label;
  await write("local", { stats });
  return stats;
}

/** Une réclamation vient d'avoir lieu, sans qu'on sache encore ce qu'elle a rapporté. */
export async function touchLastClaim(label = "") {
  const stats = await getStats();
  stats.lastClaim = Date.now();
  if (label) stats.lastClaimLabel = label;
  await write("local", { stats });
  return stats;
}

/** Paliers déjà vus comme obtenus, pour ne compter chaque drop qu'une fois. */
export async function getClaimedDrops() {
  const { claimedDropIds = [], claimedSeeded = false } = await chrome.storage.local.get([
    "claimedDropIds",
    "claimedSeeded",
  ]);
  return {
    ids: Array.isArray(claimedDropIds) ? claimedDropIds : [],
    seeded: Boolean(claimedSeeded),
  };
}

export async function setClaimedDrops(ids) {
  await write("local", { claimedDropIds: ids, claimedSeeded: true });
  return ids;
}

// --- actions à cocher -----------------------------------------------------

export async function getActions() {
  const { actions = [] } = await chrome.storage.local.get("actions");
  return Array.isArray(actions) ? actions : [];
}

export async function setActions(actions) {
  await write("local", { actions });
  return actions;
}

// --- campagnes ------------------------------------------------------------

export async function getCampaigns() {
  const { campaigns = [], campaignsAt = null } = await chrome.storage.local.get([
    "campaigns",
    "campaignsAt",
  ]);
  return { campaigns: Array.isArray(campaigns) ? campaigns : [], campaignsAt };
}

export async function setCampaigns(campaigns) {
  await write("local", { campaigns, campaignsAt: Date.now() });
}

export async function getDetailsCache() {
  const { detailsCache = {} } = await chrome.storage.local.get("detailsCache");
  return detailsCache && typeof detailsCache === "object" ? detailsCache : {};
}

export async function setDetailsCache(detailsCache) {
  await write("local", { detailsCache });
}

// --- dernière erreur ------------------------------------------------------

export async function getLastError() {
  const { lastError = null } = await chrome.storage.local.get("lastError");
  return lastError;
}

export async function setLastError(message) {
  await write("local", {
    lastError: message ? { message: String(message).slice(0, 300), at: Date.now() } : null,
  });
}

// --- état volatil ---------------------------------------------------------

const EMPTY_STATE = {
  pointsTabId: null,
  pointsChannel: null,
  dropsTabId: null,
  dropsChannel: null,
  dropsCampaignId: null,
  dropsSince: null,
  inventoryTabId: null,
  inventorySince: null,
  // Fenêtre dédiée aux onglets de l'extension, quand l'option est active.
  windowId: null,
  // tabId -> date du dernier réveil, pour ne pas s'acharner.
  wokeAt: {},
  // Position dans le tour de rôle des onglets de la fenêtre dédiée.
  rotationIndex: -1,
  // { channel, balance, hasBonus, at } : solde de points de la chaîne suivie.
  pointsBalance: null,
  // tabId -> chaîne demandée. Évite de relire l'adresse de l'onglet, donc évite
  // la permission "tabs".
  tabChannels: {},
  beats: {},
  prevBeats: {},
  // tabId -> { spadeAt, segmentAt } : dernières preuves réseau que Twitch
  // comptabilise le visionnage de cet onglet.
  counted: {},
  // { dropsAt, pointsAt } : dernières fois où une progression réelle a été
  // constatée, et { marks } les relevés qui servent à la comparer.
  proof: {},
  marks: {},
  proofCheckedAt: 0,
};

/**
 * En-têtes capturés sur les requêtes de la page Twitch, dont son jeton de session.
 * En `session` volontairement : mémoire seulement, effacé à la fermeture de Chrome,
 * jamais écrit sur le disque (docs/AUDIT-SECU.md, passe 2).
 */
export async function getCapturedHeaders() {
  const { gqlHeaders = null } = await chrome.storage.session.get("gqlHeaders");
  return gqlHeaders;
}

export async function setCapturedHeaders(captured) {
  await write("session", { gqlHeaders: captured });
  return captured;
}

export async function getState() {
  const { farmState = {} } = await chrome.storage.session.get("farmState");
  return { ...EMPTY_STATE, ...farmState };
}

export async function setState(patch) {
  const next = { ...(await getState()), ...patch };
  await write("session", { farmState: next });
  return next;
}

export async function recordBeat(tabId, beat) {
  const state = await getState();
  return setState({
    beats: { ...state.beats, [tabId]: beat },
    prevBeats: { ...state.prevBeats, [tabId]: state.beats[tabId] ?? null },
  });
}

export async function forgetTab(tabId) {
  const state = await getState();
  const beats = { ...state.beats };
  const prevBeats = { ...state.prevBeats };
  const tabChannels = { ...state.tabChannels };
  const counted = { ...state.counted };
  delete beats[tabId];
  delete prevBeats[tabId];
  delete tabChannels[tabId];
  delete counted[tabId];

  const patch = { beats, prevBeats, tabChannels, counted };
  if (state.pointsTabId === tabId) Object.assign(patch, { pointsTabId: null, pointsChannel: null });
  if (state.dropsTabId === tabId) {
    Object.assign(patch, {
      dropsTabId: null,
      dropsChannel: null,
      dropsCampaignId: null,
      dropsSince: null,
    });
  }
  if (state.inventoryTabId === tabId) patch.inventoryTabId = null;

  return setState(patch);
}
