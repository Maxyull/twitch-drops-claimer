// Réglages : valeurs par défaut + normalisation.
// Module pur (aucune API chrome) pour rester testable sous Node.

export const QUALITIES = ["160p30", "360p30", "480p30", "720p60", "source"];

export const PRIORITIES = ["endingSoon", "closestToDone", "order"];

export const DEFAULT_SETTINGS = {
  enabled: true,

  // --- Points de chaîne ---
  claimPoints: true,
  watchFavorite: true,
  favoriteChannels: [],

  // --- Drops ---
  farmDrops: true,
  autoDiscover: true,
  claimIntervalMin: 15,
  discoverIntervalMin: 30,
  priority: "endingSoon",
  campaignBlacklist: [],
  onlyLinkedCampaigns: false,
  fastClaim: false,

  // --- Lecteur en arrière-plan ---
  volumePercent: 1,
  quality: "160p30",

  // --- Notifications ---
  notifyDrops: true,
  notifyActions: true,
};

const MIN_INTERVAL = 1;
const MAX_INTERVAL = 240;
const MAX_CHANNELS = 20;

/**
 * "https://www.twitch.tv/Foo?bar=1" | "@Foo" | " Foo " -> "foo"
 * Renvoie "" si rien d'exploitable.
 */
export function normalizeChannel(input) {
  if (typeof input !== "string") return "";
  let s = input.trim();
  if (!s) return "";

  // URL complète ou partielle : on ne garde que le premier segment du chemin.
  const m = s.match(/twitch\.tv\/([^/?#\s]+)/i);
  if (m) s = m[1];

  // Hors URL, une chaîne à espaces n'est pas un login : on ne devine pas.
  s = s.replace(/^@/, "").split(/[/?#]/)[0].toLowerCase();

  // Un login Twitch : 4 à 25 caractères, lettres/chiffres/underscore.
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

/** Complète et assainit un objet de réglages partiel. */
export function normalizeSettings(raw = {}) {
  const d = DEFAULT_SETTINGS;
  return {
    enabled: bool(raw.enabled, d.enabled),

    claimPoints: bool(raw.claimPoints, d.claimPoints),
    watchFavorite: bool(raw.watchFavorite, d.watchFavorite),
    favoriteChannels: normalizeChannelList(raw.favoriteChannels),

    farmDrops: bool(raw.farmDrops, d.farmDrops),
    autoDiscover: bool(raw.autoDiscover, d.autoDiscover),
    claimIntervalMin: clampInt(raw.claimIntervalMin, MIN_INTERVAL, MAX_INTERVAL, d.claimIntervalMin),
    discoverIntervalMin: clampInt(raw.discoverIntervalMin, MIN_INTERVAL, MAX_INTERVAL, d.discoverIntervalMin),
    priority: PRIORITIES.includes(raw.priority) ? raw.priority : d.priority,
    campaignBlacklist: Array.isArray(raw.campaignBlacklist)
      ? [...new Set(raw.campaignBlacklist.filter((x) => typeof x === "string" && x))]
      : [],
    onlyLinkedCampaigns: bool(raw.onlyLinkedCampaigns, d.onlyLinkedCampaigns),
    fastClaim: bool(raw.fastClaim, d.fastClaim),

    // 0 % couperait le son : Chrome bride alors les timers de l'onglet caché.
    // On garde donc un plancher à 1 %.
    volumePercent: clampInt(raw.volumePercent, 1, 100, d.volumePercent),
    quality: QUALITIES.includes(raw.quality) ? raw.quality : d.quality,

    notifyDrops: bool(raw.notifyDrops, d.notifyDrops),
    notifyActions: bool(raw.notifyActions, d.notifyActions),
  };
}
