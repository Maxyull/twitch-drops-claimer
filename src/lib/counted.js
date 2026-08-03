// « Est-ce que Twitch me compte comme spectateur ? »
//
// On ne le devine pas, on l'observe. Trois signaux, du plus fort au plus faible :
//   1. la progression elle-même : minutes de drop accumulées, solde de points qui
//      monte. C'est irréfutable, mais lent à confirmer ;
//   2. le ping de comptage que le lecteur envoie à Twitch : preuve directe ;
//   3. les segments vidéo téléchargés : preuve que le flux est consommé,
//      condition nécessaire pour être compté.
//
// Règle de fond : **une preuve l'emporte toujours sur une déduction**. L'état du
// lecteur lu dans le DOM n'est qu'une déduction, et il s'est déjà trompé. S'il
// dit « en pause » alors que la progression avance, c'est lui qui a tort.
//
// Module pur.

export const COUNTED = {
  CONFIRMED: "confirmed", // progression ou ping de comptage observés
  STREAMING: "streaming", // flux téléchargé, mais aucune preuve plus forte
  NO: "no", // aucun signal, et rien qui laisse penser que ça tourne
  UNKNOWN: "unknown", // trop tôt pour se prononcer
};

/**
 * Pourquoi ce n'est pas compté. « Non compté » sans explication renvoie chercher
 * au hasard, alors que les trois causes possibles n'appellent pas les mêmes gestes.
 */
export const REASON = {
  PLAYER_STOPPED: "player_stopped", // le lecteur ne tourne pas
  NO_SIGNAL: "no_signal", // rien n'a jamais été observé
  STALE: "stale", // des signaux, mais trop vieux
};

export const PROGRESS_MAX_AGE_MS = 15 * 60_000;
export const SPADE_MAX_AGE_MS = 3 * 60_000;
export const SEGMENT_MAX_AGE_MS = 45_000;
/**
 * En dessous, aucune preuve n'est encore attendue : la progression se vérifie
 * toutes les cinq minutes, annoncer « non compté » avant serait faux.
 */
export const WARMUP_MS = 6 * 60_000;

function age(at, now) {
  return typeof at === "number" && at > 0 ? now - at : null;
}

/**
 * @param {object} signals { progressAt, spadeAt, segmentAt }
 * @param {object} ctx { now, since, playing }
 */
export function evaluateCounted(signals, ctx = {}) {
  const { now = Date.now(), since = null, playing = true } = ctx;

  const progressAge = age(signals?.progressAt, now);
  const spadeAge = age(signals?.spadeAt, now);
  const segmentAge = age(signals?.segmentAt, now);
  const out = (code, reason = null) => ({ code, reason, progressAge, spadeAge, segmentAge });

  // Les preuves d'abord, avant tout jugement sur l'état du lecteur.
  if (progressAge !== null && progressAge < PROGRESS_MAX_AGE_MS) return out(COUNTED.CONFIRMED);
  if (spadeAge !== null && spadeAge < SPADE_MAX_AGE_MS) return out(COUNTED.CONFIRMED);
  if (segmentAge !== null && segmentAge < SEGMENT_MAX_AGE_MS) return out(COUNTED.STREAMING);

  const jamaisRienVu = progressAge === null && spadeAge === null && segmentAge === null;

  if (!playing) return out(COUNTED.NO, REASON.PLAYER_STOPPED);
  if (since !== null && now - since < WARMUP_MS) return out(COUNTED.UNKNOWN);
  return out(COUNTED.NO, jamaisRienVu ? REASON.NO_SIGNAL : REASON.STALE);
}

/** Le visionnage est-il en train d'être comptabilisé, au mieux de ce qu'on sait ? */
export function isCounted(code) {
  return code === COUNTED.CONFIRMED || code === COUNTED.STREAMING;
}

/** Une valeur de progression a-t-elle augmenté depuis le dernier relevé ? */
export function progressAdvanced(previous, current) {
  return typeof previous === "number" && typeof current === "number" && current > previous;
}

/**
 * Reconnaît les URL qui portent les signaux réseau.
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
