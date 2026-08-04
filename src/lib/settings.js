// Settings: defaults + normalisation.
// Pure module (no chrome API) so it stays testable under Node.

import { AUDIO_ONLY } from "./quality.js";
import { LANGUAGES } from "./messages.js";

export { LANGUAGES };

export const QUALITIES = ["160p30", "360p30", "480p30", "720p60", "source", AUDIO_ONLY];

export const PRIORITIES = ["endingSoon", "closestToDone", "order"];

export const DEFAULT_SETTINGS = {
  enabled: true,
  // Interface language: "auto" follows the browser. `chrome.i18n` cannot make
  // that choice, hence the catalogue we load ourselves (src/lib/messages.js).
  language: "auto",

  // --- Channel points ---
  claimPoints: true,
  watchFavorite: true,
  favoriteChannels: [],
  // Go and take the streak bonus on a favourite that has just gone live, even
  // if that means leaving the current one. See src/lib/streak.js.
  watchStreak: true,
  // Join the favourite channel's raids: Twitch pays a bonus for them.
  joinRaids: true,

  // --- Drops ---
  farmDrops: true,
  autoDiscover: true,
  // Farming tabs in parallel, one per campaign. Twitch probably advances only
  // one stream at a time: the "counted as a viewer" badge on each row says
  // which one is really moving, rather than deciding on Twitch's behalf.
  farmTabs: 2,
  claimIntervalMin: 15,
  discoverIntervalMin: 30,
  priority: "endingSoon",
  campaignBlacklist: [],
  // Campaigns handled before all the others, among themselves in expiry order.
  // Once they are done, the rest follows.
  focusCampaigns: [],
  // The rest in random order rather than by expiry date.
  randomAfterFocus: false,
  onlyLinkedCampaigns: false,
  fastClaim: false,

  // --- Background tabs ---
  // Muted by default: Chrome refuses autoplay with sound without a user gesture,
  // so the player would simply never start.
  muteTabs: true,
  // Separate window for the extension's tabs: it lets us wake them without ever
  // stealing focus from the window being worked in.
  dedicatedWindow: true,
  wakeStuckTabs: true,
  // Twitch's real-time channel: chests and tiers reported within the second.
  // Pure acceleration, everything works without it (see src/background/pubsub.js).
  realtime: true,
  // Periodic pass over each tab: activate it, and reload it if it is not green.
  // 0 turns the rotation off.
  rotateIntervalMin: 15,

  // --- Background player ---
  volumePercent: 1,
  quality: "160p30",

  // --- Notifications ---
  notifyDrops: true,
  notifyActions: true,
  // Warn when farming has not been running for a while.
  notifyProblems: true,
  alertAfterMin: 15,
};

const MIN_INTERVAL = 1;
const MAX_INTERVAL = 240;
const MAX_CHANNELS = 20;
/** Beyond this we open tabs for nothing: Twitch will not count that many. */
export const MAX_FARM_TABS = 4;

/**
 * "https://www.twitch.tv/Foo?bar=1" | "@Foo" | " Foo " -> "foo"
 * Returns "" when there is nothing usable.
 */
export function normalizeChannel(input) {
  if (typeof input !== "string") return "";
  let s = input.trim();
  if (!s) return "";

  // Full or partial URL: keep only the first path segment.
  const m = s.match(/twitch\.tv\/([^/?#\s]+)/i);
  if (m) s = m[1];

  // Outside a URL, a string with spaces is not a login: do not guess.
  s = s.replace(/^@/, "").split(/[/?#]/)[0].toLowerCase();

  // A Twitch login: 4 to 25 characters, letters/digits/underscore.
  if (!/^[a-z0-9_]{1,25}$/.test(s)) return "";
  return s;
}

export function normalizeChannelList(input) {
  const raw = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? input.split(/[\n,;]+/)
      : [];
  const out = [];
  for (const item of raw) {
    const login = normalizeChannel(item);
    if (login && !out.includes(login)) out.push(login);
  }
  return out.slice(0, MAX_CHANNELS);
}

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function bool(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

/** List of campaign ids: non-empty strings, no duplicates. */
function idList(value) {
  return Array.isArray(value)
    ? [...new Set(value.filter((x) => typeof x === "string" && x))]
    : [];
}

/** Completes and sanitises a partial settings object. */
export function normalizeSettings(raw = {}) {
  const d = DEFAULT_SETTINGS;
  return {
    enabled: bool(raw.enabled, d.enabled),
    language: LANGUAGES.includes(raw.language) ? raw.language : d.language,

    claimPoints: bool(raw.claimPoints, d.claimPoints),
    watchFavorite: bool(raw.watchFavorite, d.watchFavorite),
    favoriteChannels: normalizeChannelList(raw.favoriteChannels),
    watchStreak: bool(raw.watchStreak, d.watchStreak),
    joinRaids: bool(raw.joinRaids, d.joinRaids),

    farmDrops: bool(raw.farmDrops, d.farmDrops),
    autoDiscover: bool(raw.autoDiscover, d.autoDiscover),
    farmTabs: clampInt(raw.farmTabs, 1, MAX_FARM_TABS, d.farmTabs),
    claimIntervalMin: clampInt(raw.claimIntervalMin, MIN_INTERVAL, MAX_INTERVAL, d.claimIntervalMin),
    discoverIntervalMin: clampInt(raw.discoverIntervalMin, MIN_INTERVAL, MAX_INTERVAL, d.discoverIntervalMin),
    priority: PRIORITIES.includes(raw.priority) ? raw.priority : d.priority,
    campaignBlacklist: idList(raw.campaignBlacklist),
    focusCampaigns: idList(raw.focusCampaigns),
    randomAfterFocus: bool(raw.randomAfterFocus, d.randomAfterFocus),
    onlyLinkedCampaigns: bool(raw.onlyLinkedCampaigns, d.onlyLinkedCampaigns),
    fastClaim: bool(raw.fastClaim, d.fastClaim),

    muteTabs: bool(raw.muteTabs, d.muteTabs),
    dedicatedWindow: bool(raw.dedicatedWindow, d.dedicatedWindow),
    wakeStuckTabs: bool(raw.wakeStuckTabs, d.wakeStuckTabs),
    realtime: bool(raw.realtime, d.realtime),
    // 0 is a legitimate value here: it turns the rotation off.
    rotateIntervalMin: clampInt(raw.rotateIntervalMin, 0, MAX_INTERVAL, d.rotateIntervalMin),

    // 0 % would mute the sound, and Chrome then throttles the hidden tab's
    // timers. Hence the floor at 1 %.
    volumePercent: clampInt(raw.volumePercent, 1, 100, d.volumePercent),
    quality: QUALITIES.includes(raw.quality) ? raw.quality : d.quality,

    notifyDrops: bool(raw.notifyDrops, d.notifyDrops),
    notifyActions: bool(raw.notifyActions, d.notifyActions),
    notifyProblems: bool(raw.notifyProblems, d.notifyProblems),
    alertAfterMin: clampInt(raw.alertAfterMin, 1, MAX_INTERVAL, d.alertAfterMin),
  };
}
