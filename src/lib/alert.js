// Warning when the farm stops running.
//
// All the diagnosis built so far only speaks to whoever opens the popup. A user
// starts farming in the evening, does not reopen it, and loses the night without
// ever knowing they lost it.
//
// Pure module.

export const DEFAULT_ALERT_AFTER_MS = 15 * 60_000;
/** A lasting failure must not produce one notification per cycle. */
export const REPEAT_AFTER_MS = 60 * 60_000;

/**
 * @param {object} etat   { green, code, brokenSince, alertedAt }
 * @param {object} ctx    { now, afterMs, repeatMs, idleCode }
 * @returns {{brokenSince: number|null, alertedAt: number|null, notify: boolean, brokenFor: number}}
 */
export function evaluateAlert(etat, ctx = {}) {
  const {
    now = Date.now(),
    afterMs = DEFAULT_ALERT_AFTER_MS,
    repeatMs = REPEAT_AFTER_MS,
    idleCode = "disabled",
  } = ctx;

  // Having nothing to watch is not a failure: with no favourite channel and no
  // live campaign, the extension simply has nothing to do. Alerting on that
  // would teach the user to ignore alerts.
  const auRepos = etat?.code === idleCode;

  if (etat?.green || auRepos) {
    return { brokenSince: null, alertedAt: null, notify: false, brokenFor: 0 };
  }

  const brokenSince = etat?.brokenSince ?? now;
  const brokenFor = now - brokenSince;
  const alertedAt = etat?.alertedAt ?? null;

  const assezLongtemps = brokenFor >= afterMs;
  const dejaDit = alertedAt !== null && now - alertedAt < repeatMs;

  if (!assezLongtemps || dejaDit) {
    return { brokenSince, alertedAt, notify: false, brokenFor };
  }

  return { brokenSince, alertedAt: now, notify: true, brokenFor };
}

/** Elapsed minutes, for the notification text. */
export function minutesOf(ms) {
  return Math.max(1, Math.round(ms / 60_000));
}
