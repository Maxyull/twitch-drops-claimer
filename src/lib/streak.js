// Watch streak: which favourite channel to watch first.
//
// Twitch pays a streak bonus when you are present at the start of a stream you
// have not watched yet. About six minutes of presence is enough, and the bonus
// is not given twice on the same stream. A channel that just went live is
// therefore worth far more than one that has been up for six hours, where only
// the chest is left to collect.
//
// This is the rule from Twitch-Channel-Points-Miner-v2: it prioritises channels
// whose streak has not been taken yet and where fewer than seven minutes have
// been watched.
//
// Pure module.

/** Six minutes is enough for the bonus; keep one minute of margin. */
export const STREAK_MINUTES = 7;
/** Past that, the stream is no longer "a start of stream" and the bonus is gone. */
export const FRESH_MINUTES = 30;

/**
 * Can this channel still pay the streak?
 *
 * @param {object} chaine  { startedAt, watchedMs }
 * @param {object} ctx     { now, streakMinutes, freshMinutes }
 */
export function streakReachable(chaine, ctx = {}) {
  const {
    now = Date.now(),
    streakMinutes = STREAK_MINUTES,
    freshMinutes = FRESH_MINUTES,
  } = ctx;

  const startedAt = Number(chaine?.startedAt);
  // With no start date we do not know, so we do not pretend we do.
  if (!Number.isFinite(startedAt) || startedAt <= 0) return false;

  const ageMin = (now - startedAt) / 60_000;
  if (ageMin < 0 || ageMin > freshMinutes) return false;

  const watchedMin = Math.max(0, Number(chaine?.watchedMs) || 0) / 60_000;
  return watchedMin < streakMinutes;
}

/**
 * Orders favourite channels: the ones that can still pay the streak first, most
 * recently started at the top. The rest keeps its input order, which is the one
 * the user typed.
 *
 * @param {Array<{login:string, startedAt?:number, watchedMs?:number}>} chaines
 */
export function rankForStreak(chaines, ctx = {}) {
  const liste = (chaines || []).filter((c) => c?.login);

  const eligibles = liste
    .filter((c) => streakReachable(c, ctx))
    // Freshest first: that is the one with the most time left to reach the six
    // minutes.
    .sort((a, b) => Number(b.startedAt) - Number(a.startedAt));

  const eligiblesSet = new Set(eligibles.map((c) => c.login));
  const reste = liste.filter((c) => !eligiblesSet.has(c.login));

  return [...eligibles, ...reste].map((c) => c.login);
}
