// Réglages : valeurs par défaut + normalisation.
// Module pur (aucune API chrome) pour rester testable sous Node.

import { AUDIO_ONLY } from "./quality.js";

export const QUALITIES = ["160p30", "360p30", "480p30", "720p60", "source", AUDIO_ONLY];

export const PRIORITIES = ["endingSoon", "closestToDone", "order"];

export const DEFAULT_SETTINGS = {
  enabled: true,

  // --- Points de chaîne ---
  claimPoints: true,
  watchFavorite: true,
  favoriteChannels: [],
  // Aller chercher le bonus de série sur une favorite qui vient d'ouvrir,
  // quitte à quitter celle en cours. Voir src/lib/streak.js.
  watchStreak: true,
  // Rejoindre les raids de la chaîne favorite : Twitch y verse un bonus.
  joinRaids: true,

  // --- Drops ---
  farmDrops: true,
  autoDiscover: true,
  // Onglets de farm en parallèle, un par campagne. Twitch ne fait probablement
  // progresser qu'un flux à la fois : le badge « compté en viewer » de chaque
  // ligne dit lequel avance vraiment, plutôt que de trancher à sa place.
  farmTabs: 2,
  claimIntervalMin: 15,
  discoverIntervalMin: 30,
  priority: "endingSoon",
  campaignBlacklist: [],
  // Campagnes traitées avant toutes les autres, entre elles dans l'ordre
  // d'expiration. Une fois qu'elles sont finies, on passe au reste.
  focusCampaigns: [],
  // Le reste dans un ordre aléatoire plutôt que par date d'expiration.
  randomAfterFocus: false,
  onlyLinkedCampaigns: false,
  fastClaim: false,

  // --- Onglets d'arrière-plan ---
  // Sourdine par défaut : Chrome interdit la lecture automatique avec du son
  // sans geste de l'utilisateur, le lecteur ne démarrerait donc jamais.
  muteTabs: true,
  // Fenêtre séparée pour les onglets de l'extension : elle permet de les
  // réveiller sans jamais voler le focus de la fenêtre où l'on travaille.
  dedicatedWindow: true,
  wakeStuckTabs: true,
  // Canal temps réel de Twitch : coffres et paliers signalés à la seconde.
  // Pure accélération, tout fonctionne sans (cf. src/background/pubsub.js).
  realtime: true,
  // Passage périodique sur chaque onglet : on l'active, et on le recharge s'il
  // n'est pas au vert. 0 désactive la rotation.
  rotateIntervalMin: 15,

  // --- Lecteur en arrière-plan ---
  volumePercent: 1,
  quality: "160p30",

  // --- Notifications ---
  notifyDrops: true,
  notifyActions: true,
  // Prévenir quand le farm ne tourne plus depuis un moment.
  notifyProblems: true,
  alertAfterMin: 15,
};

const MIN_INTERVAL = 1;
const MAX_INTERVAL = 240;
const MAX_CHANNELS = 20;
/** Au-delà, on ouvre des onglets pour rien : Twitch n'en comptera pas autant. */
export const MAX_FARM_TABS = 4;

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

/** Liste d'identifiants de campagne : chaînes non vides, sans doublon. */
function idList(value) {
  return Array.isArray(value)
    ? [...new Set(value.filter((x) => typeof x === "string" && x))]
    : [];
}

/** Complète et assainit un objet de réglages partiel. */
export function normalizeSettings(raw = {}) {
  const d = DEFAULT_SETTINGS;
  return {
    enabled: bool(raw.enabled, d.enabled),

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
    // 0 est une valeur légitime ici : elle coupe la rotation.
    rotateIntervalMin: clampInt(raw.rotateIntervalMin, 0, MAX_INTERVAL, d.rotateIntervalMin),

    // 0 % couperait le son : Chrome bride alors les timers de l'onglet caché.
    // On garde donc un plancher à 1 %.
    volumePercent: clampInt(raw.volumePercent, 1, 100, d.volumePercent),
    quality: QUALITIES.includes(raw.quality) ? raw.quality : d.quality,

    notifyDrops: bool(raw.notifyDrops, d.notifyDrops),
    notifyActions: bool(raw.notifyActions, d.notifyActions),
    notifyProblems: bool(raw.notifyProblems, d.notifyProblems),
    alertAfterMin: clampInt(raw.alertAfterMin, 1, MAX_INTERVAL, d.alertAfterMin),
  };
}
