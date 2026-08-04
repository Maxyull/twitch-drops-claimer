// Deciding that a farming tab has stopped paying.
//
// A tab whose content script no longer answers is dead: nothing will ever come
// out of it again. Until now `stillWorth` only asked whether the tab existed,
// whether the campaign was active and whether the channel was live. All three
// stay true forever on a dead tab, so the campaign kept its slot and the whole
// rotation stopped (issue #68).
//
// Pure module.

/** No heartbeat for this long means the tab is gone, not slow. */
export const DEAD_AFTER_MS = 3 * 60_000;

/**
 * How long a freshly opened tab is left alone. A tab that just opened has not
 * had time to load Twitch, let alone send a heartbeat: judging it immediately
 * would close it before it ever had a chance.
 */
export const GRACE_MS = 2 * 60_000;

/**
 * Deliberately narrow: only the "the tab answers nothing" signal.
 *
 * Absence of progress is NOT used here, and that is on purpose. Twitch probably
 * advances only one stream at a time (docs/PITFALLS.md), so with two farming
 * tabs the second one can legitimately sit at zero progress for hours. Rotating
 * on that would churn tabs forever and cost more than the bug it fixes.
 *
 * A missing heartbeat, on the other hand, is unambiguous.
 *
 * @param {object} entry  { since }
 * @param {object} ctx    { now, beatAt, deadAfterMs, graceMs }
 */
export function isTabDead(entry, ctx = {}) {
  const {
    now = Date.now(),
    beatAt = null,
    deadAfterMs = DEAD_AFTER_MS,
    graceMs = GRACE_MS,
  } = ctx;

  const since = Number(entry?.since);
  // No opening date: we know nothing, so we claim nothing.
  if (!Number.isFinite(since) || since <= 0) return false;
  if (now - since < graceMs) return false;

  const last = Number(beatAt);
  if (!Number.isFinite(last) || last <= 0) return true;
  return now - last >= deadAfterMs;
}
