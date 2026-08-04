// Prévenir quand le farm ne tourne plus.
//
// Tout le diagnostic construit jusqu'ici ne sert qu'à celui qui ouvre le popup.
// Un utilisateur lance le farm le soir, ne le rouvre pas, et perd sa nuit sans
// jamais savoir qu'il l'a perdue.
//
// Module pur.

export const DEFAULT_ALERT_AFTER_MS = 15 * 60_000;
/** Une panne qui dure ne doit pas produire une notification par cycle. */
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

  // Rien à surveiller n'est pas une panne : sans chaîne favorite ni campagne
  // en direct, l'extension n'a simplement rien à faire. Alerter là-dessus
  // apprendrait à ignorer les alertes.
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

/** Minutes écoulées, pour le texte de la notification. */
export function minutesOf(ms) {
  return Math.max(1, Math.round(ms / 60_000));
}
