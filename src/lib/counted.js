// "Is Twitch counting me as a viewer?"
//
// We do not guess it, we observe it. Three signals, strongest to weakest:
//   1. progress itself: drop minutes accumulating, point balance going up. That
//      is irrefutable, but slow to confirm;
//   2. the watch ping the player sends to Twitch: direct proof;
//   3. downloaded video segments: proof the stream is being consumed, which is a
//      necessary condition for being counted.
//
// Underlying rule: **evidence always beats deduction**. Player state read from
// the DOM is only a deduction, and it has already been wrong. If it says "paused"
// while progress is advancing, it is the player state that is wrong.
//
// Pure module.

export const COUNTED = {
  CONFIRMED: "confirmed", // progress or a watch ping observed
  STREAMING: "streaming", // stream downloading, but no stronger evidence
  NO: "no", // no signal, and nothing suggesting it is running
  UNKNOWN: "unknown", // too early to say
};

/**
 * Why it is not counted. "Not counted" with no explanation sends you looking at
 * random, while the three possible causes call for entirely different moves.
 */
export const REASON = {
  PLAYER_STOPPED: "player_stopped", // the player is not running
  NO_SIGNAL: "no_signal", // nothing has ever been observed
  STALE: "stale", // signals, but too old
};

export const PROGRESS_MAX_AGE_MS = 15 * 60_000;
export const SPADE_MAX_AGE_MS = 3 * 60_000;
export const SEGMENT_MAX_AGE_MS = 45_000;
/**
 * Below this, no evidence is expected yet: progress is checked every five
 * minutes, so announcing "not counted" any earlier would be wrong.
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

  // Evidence first, before any judgement on the player's state.
  if (progressAge !== null && progressAge < PROGRESS_MAX_AGE_MS) return out(COUNTED.CONFIRMED);
  if (spadeAge !== null && spadeAge < SPADE_MAX_AGE_MS) return out(COUNTED.CONFIRMED);
  if (segmentAge !== null && segmentAge < SEGMENT_MAX_AGE_MS) return out(COUNTED.STREAMING);

  const jamaisRienVu = progressAge === null && spadeAge === null && segmentAge === null;

  if (!playing) return out(COUNTED.NO, REASON.PLAYER_STOPPED);
  if (since !== null && now - since < WARMUP_MS) return out(COUNTED.UNKNOWN);
  return out(COUNTED.NO, jamaisRienVu ? REASON.NO_SIGNAL : REASON.STALE);
}

/** Is the viewing being counted, as far as we can tell? */
export function isCounted(code) {
  return code === COUNTED.CONFIRMED || code === COUNTED.STREAMING;
}

/** Has a progress value gone up since the last reading? */
export function progressAdvanced(previous, current) {
  return typeof previous === "number" && typeof current === "number" && current > previous;
}

/**
 * Recognises the URLs that carry the network signals.
 * Kept out of the service worker so it can be tested without a browser.
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
