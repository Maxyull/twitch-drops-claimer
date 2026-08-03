// « Est-ce que Twitch me compte comme spectateur ? »
//
// On ne le devine pas, on l'observe. Deux signaux réseau, du plus fort au plus faible :
//   1. le ping de comptage que le lecteur envoie à Twitch (spade) : preuve directe ;
//   2. les segments vidéo téléchargés : preuve que le flux est réellement consommé,
//      condition nécessaire pour être compté.
// Un bloqueur de pub peut tuer le signal 1 sans empêcher le comptage, d'où l'état
// intermédiaire au lieu d'une réponse binaire qui mentirait.
//
// Module pur.

export const COUNTED = {
  CONFIRMED: "confirmed", // ping de comptage vu récemment
  STREAMING: "streaming", // flux téléchargé, mais aucun ping observé
  NO: "no", // rien, ou lecteur à l'arrêt
  UNKNOWN: "unknown", // trop tôt pour se prononcer
};

export const SPADE_MAX_AGE_MS = 3 * 60_000;
export const SEGMENT_MAX_AGE_MS = 45_000;
/** En dessous, l'onglet vient d'ouvrir : aucun signal n'est encore attendu. */
export const WARMUP_MS = 90_000;

/**
 * @param {object} signals { spadeAt, segmentAt } horodatages des derniers signaux
 * @param {object} ctx { now, since, playing }
 * @returns {{code:string, spadeAge:number|null, segmentAge:number|null}}
 */
export function evaluateCounted(signals, ctx = {}) {
  const { now = Date.now(), since = null, playing = true } = ctx;
  const spadeAt = signals?.spadeAt ?? null;
  const segmentAt = signals?.segmentAt ?? null;

  const spadeAge = spadeAt ? now - spadeAt : null;
  const segmentAge = segmentAt ? now - segmentAt : null;
  const out = (code) => ({ code, spadeAge, segmentAge });

  if (!playing) return out(COUNTED.NO);
  if (spadeAge !== null && spadeAge < SPADE_MAX_AGE_MS) return out(COUNTED.CONFIRMED);
  if (segmentAge !== null && segmentAge < SEGMENT_MAX_AGE_MS) return out(COUNTED.STREAMING);
  if (since !== null && now - since < WARMUP_MS) return out(COUNTED.UNKNOWN);
  return out(COUNTED.NO);
}

/** Le visionnage est-il en train d'être comptabilisé, au mieux de ce qu'on sait ? */
export function isCounted(code) {
  return code === COUNTED.CONFIRMED || code === COUNTED.STREAMING;
}

/**
 * Reconnaît les URL qui portent chacun des deux signaux.
 * Séparé du service worker pour être testable sans navigateur.
 */
export function classifyRequest(url) {
  if (typeof url !== "string") return null;
  let host;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return null;
    host = parsed.hostname.toLowerCase();
  } catch {
    return null;
  }

  if (host === "spade.twitch.tv") return "spade";
  if (host.endsWith(".ttvnw.net")) return "segment";
  return null;
}
