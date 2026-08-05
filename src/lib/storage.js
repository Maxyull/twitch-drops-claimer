// The one door into storage: defaults, versioned schema, migration on update,
// quota handled.
//   - `local`   : settings, counters, actions to tick off, campaign cache.
//   - `session` : volatile state (tabs, heartbeats), the service worker dies often.
// Nothing sensitive is written here: no token, no password
// (see docs/SECURITY-AUDIT.md, pass 2).

import { DEFAULT_SETTINGS, normalizeSettings } from "./settings.js";
import { ERROR, describe, isDescriptor } from "./errors.js";

export const STORAGE_VERSION = 2;

export const DEFAULT_STATS = { drops: 0, points: 0, lastClaim: null, lastClaimLabel: "" };

/** Quota-tolerant write: a full storage must not blow up the loop. */
async function write(area, values) {
  try {
    await chrome.storage[area].set(values);
    return { ok: true };
  } catch (err) {
    const message = err?.message ?? String(err);
    console.warn("[TDC]", area, "write refused:", message);
    if (area !== "local") return { ok: false, error: message };
    try {
      // Written directly rather than through `setLastError`: that function calls
      // `write`, and a storage that has just refused a write would recurse.
      await chrome.storage.local.set({
        lastError: { ...describe(ERROR.STORAGE, [message]), at: Date.now() },
      });
    } catch {
      /* storage really is dead, give up quietly */
    }
    return { ok: false, error: message };
  }
}

// --- migration ------------------------------------------------------------

/**
 * v1 (the original extension): { enabled, claimPoints, stats }.
 * v2: full settings + actions to tick off + campaign cache.
 */
export async function migrate() {
  const { storageVersion = 1, ...rest } = await chrome.storage.local.get(null);
  if (storageVersion === STORAGE_VERSION) return storageVersion;

  // Merge, never reset: any setting already present and valid survives, and
  // `normalizeSettings` drops whatever is not and fills the gaps. Listing the
  // keys to keep would silently lose the ones we forget, and that loss would
  // replay on every reload for as long as `storageVersion` stays unwritten.
  const migrated = normalizeSettings({ ...DEFAULT_SETTINGS, ...rest });

  await write("local", {
    ...migrated,
    stats: { ...DEFAULT_STATS, ...(rest.stats ?? {}) },
    actions: Array.isArray(rest.actions) ? rest.actions : [],
    storageVersion: STORAGE_VERSION,
  });
  return STORAGE_VERSION;
}

// --- settings -------------------------------------------------------------

export async function getSettings() {
  const raw = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return normalizeSettings(raw);
}

export async function setSettings(patch) {
  const merged = normalizeSettings({ ...(await getSettings()), ...patch });
  await write("local", merged);
  return merged;
}

// --- counters ---------------------------------------------------------------

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

/** A claim just happened, before we know what it brought in. */
export async function touchLastClaim(label = "") {
  const stats = await getStats();
  stats.lastClaim = Date.now();
  if (label) stats.lastClaimLabel = label;
  await write("local", { stats });
  return stats;
}

/** Claim log: what was taken, and when. */
export async function getHistory() {
  const { history = [] } = await chrome.storage.local.get("history");
  return Array.isArray(history) ? history : [];
}

export async function setHistory(history) {
  await write("local", { history });
  return history;
}

/** Tiers already seen as obtained, so each drop is counted exactly once. */
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

// --- actions to tick off ----------------------------------------------------

export async function getActions() {
  const { actions = [] } = await chrome.storage.local.get("actions");
  return Array.isArray(actions) ? actions : [];
}

export async function setActions(actions) {
  await write("local", { actions });
  return actions;
}

// --- campaigns --------------------------------------------------------------

export async function getCampaigns() {
  const { campaigns = [], campaignsAt = null } = await chrome.storage.local.get([
    "campaigns",
    "campaignsAt",
  ]);
  return { campaigns: Array.isArray(campaigns) ? campaigns : [], campaignsAt };
}

/**
 * `campaignsAt` dates the last DISCOVERY, not the last refresh. A plain progress
 * update therefore passes `touchDate: false`: otherwise the screen would claim it
 * had just gone looking for campaigns when it had looked for nothing.
 */
export async function setCampaigns(campaigns, { touchDate = true } = {}) {
  await write("local", touchDate ? { campaigns, campaignsAt: Date.now() } : { campaigns });
}

export async function getDetailsCache() {
  const { detailsCache = {} } = await chrome.storage.local.get("detailsCache");
  return detailsCache && typeof detailsCache === "object" ? detailsCache : {};
}

export async function setDetailsCache(detailsCache) {
  await write("local", { detailsCache });
}

// --- last error -------------------------------------------------------------

export async function getLastError() {
  const { lastError = null } = await chrome.storage.local.get("lastError");
  return lastError;
}

/**
 * @param {{key: string, params: string[]}|null} entry a descriptor from
 *   `src/lib/errors.js`, or `null` to clear. A bare string is refused on purpose:
 *   that was how French sentences reached the popup (#76).
 */
export async function setLastError(entry) {
  if (!entry) {
    await write("local", { lastError: null });
    return;
  }
  if (!isDescriptor(entry)) throw new TypeError("setLastError expects a descriptor, not a string");

  await write("local", {
    lastError: {
      key: entry.key,
      // Bounded here rather than at every call site: a Twitch error text or a
      // storage message can be arbitrarily long, and it ends up in the popup.
      params: (entry.params ?? []).map((p) => String(p).slice(0, 300)),
      at: Date.now(),
    },
  });
}

// --- volatile state ---------------------------------------------------------

const EMPTY_STATE = {
  pointsTabId: null,
  pointsChannel: null,
  // Since when we have been watching this favourite: tells whether the streak
  // bonus is still reachable there.
  pointsSince: null,
  // One farming tab per campaign: { tabId, channel, campaignId, since }.
  dropTabs: [],
  inventoryTabId: null,
  inventorySince: null,
  // Window dedicated to the extension's tabs, when the option is on.
  windowId: null,
  // When the last one was created, so we do not chain more of them when we
  // cannot find it again afterwards.
  windowCreatedAt: 0,
  // tabId -> when it was last woken, so we do not keep hammering it.
  wokeAt: {},
  // Position in the round-robin over the dedicated window's tabs.
  rotationIndex: -1,
  // { channel, balance, hasBonus, at }: point balance of the followed channel.
  pointsBalance: null,
  // channel -> { balance, hasBonus, at }: balance of EVERY watched channel, not
  // only the favourite. A farming channel hands out chests too.
  pointsByChannel: {},
  // channel -> last chest claimed, so it is not claimed twice. Per channel: one
  // global id would lose a channel's chest as soon as another channel claimed
  // one.
  claimedBonusIds: {},
  // tabId -> requested channel. Saves re-reading the tab's address, which is
  // what keeps the "tabs" permission unnecessary.
  tabChannels: {},
  beats: {},
  prevBeats: {},
  // tabId -> { spadeAt, segmentAt }: latest network evidence that Twitch is
  // counting this tab's viewing.
  counted: {},
  // { dropsAt, pointsAt }: the last times real progress was observed, and
  // { marks } the readings used to compare against.
  proof: {},
  marks: {},
  proofCheckedAt: 0,
  // Live progress: last pass, channel ids kept, and the flag raised if Twitch
  // retires the query fingerprint.
  liveCheckedAt: 0,
  channelIds: {},
  livePersistedGone: false,
  // Since when farming has been broken, and when we warned about it.
  brokenSince: null,
  alertedAt: null,
};

/**
 * Headers captured from the Twitch page's own requests, including its session token.
 * In `session` on purpose: memory only, cleared when Chrome closes, never written to
 * disk (docs/SECURITY-AUDIT.md, pass 2).
 */
export async function getCapturedHeaders() {
  const { gqlHeaders = null } = await chrome.storage.session.get("gqlHeaders");
  return gqlHeaders;
}

export async function setCapturedHeaders(captured) {
  await write("session", { gqlHeaders: captured });
  return captured;
}

/**
 * What has to survive an extension reload: the identity of the tabs and of the
 * window. `storage.session` is cleared at that moment, and everything built to
 * make up for that loss rested on a URL marker Twitch wipes regularly.
 *
 * An id gone stale after a browser restart costs nothing: every read already
 * checks the tab exists. One window too many does cost something.
 */
const PERSISTENT_STATE_KEYS = new Set([
  "pointsTabId",
  "pointsChannel",
  "pointsSince",
  "dropTabs",
  "inventoryTabId",
  "inventorySince",
  "windowId",
  "windowCreatedAt",
  "tabChannels",
]);

const isPersistent = (key) => PERSISTENT_STATE_KEYS.has(key);

export async function getState() {
  const [{ tabState = {} }, { farmState = {} }] = await Promise.all([
    chrome.storage.local.get("tabState"),
    chrome.storage.session.get("farmState"),
  ]);
  return { ...EMPTY_STATE, ...tabState, ...farmState };
}

export async function setState(patch) {
  const next = { ...(await getState()), ...patch };
  const keys = Object.keys(patch);

  // Only the area actually touched gets written: heartbeats arrive every five
  // seconds, and there is no reason for them to reach the disk.
  const ecritures = [];
  if (keys.some(isPersistent)) {
    ecritures.push(
      write("local", {
        tabState: Object.fromEntries(Object.entries(next).filter(([k]) => isPersistent(k))),
      }),
    );
  }
  if (keys.some((k) => !isPersistent(k))) {
    ecritures.push(
      write("session", {
        farmState: Object.fromEntries(Object.entries(next).filter(([k]) => !isPersistent(k))),
      }),
    );
  }

  await Promise.all(ecritures);
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
  const dropTabs = (state.dropTabs ?? []).filter((entry) => entry.tabId !== tabId);
  if (dropTabs.length !== (state.dropTabs ?? []).length) patch.dropTabs = dropTabs;
  if (state.inventoryTabId === tabId) patch.inventoryTabId = null;

  return setState(patch);
}
