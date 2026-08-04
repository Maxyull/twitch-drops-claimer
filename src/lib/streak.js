// Série de visionnage : quelle chaîne favorite regarder en priorité.
//
// Twitch verse un bonus de série quand on est présent au début d'un flux qu'on
// n'a pas encore regardé. Environ six minutes de présence suffisent, et le bonus
// ne se redonne pas sur le même flux. Une chaîne qui vient d'ouvrir vaut donc
// beaucoup plus qu'une chaîne allumée depuis six heures, sur laquelle il n'y a
// plus que le coffre à ramasser.
//
// C'est la règle de Twitch-Channel-Points-Miner-v2 : il priorise les chaînes
// dont la série n'est pas encore prise et sur lesquelles moins de sept minutes
// ont été regardées.
//
// Module pur.

/** Six minutes suffisent au bonus ; on garde une minute de marge. */
export const STREAK_MINUTES = 7;
/** Au-delà, le flux n'est plus « un début de flux » et le bonus est passé. */
export const FRESH_MINUTES = 30;

/**
 * Une chaîne peut-elle encore rapporter la série ?
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
  // Sans date de début, on ne sait pas : on ne prétend pas que si.
  if (!Number.isFinite(startedAt) || startedAt <= 0) return false;

  const ageMin = (now - startedAt) / 60_000;
  if (ageMin < 0 || ageMin > freshMinutes) return false;

  const watchedMin = Math.max(0, Number(chaine?.watchedMs) || 0) / 60_000;
  return watchedMin < streakMinutes;
}

/**
 * Ordonne des chaînes favorites : celles qui peuvent encore rapporter la série
 * d'abord, la plus récemment ouverte en tête. Le reste garde l'ordre d'entrée,
 * qui est celui que l'utilisateur a saisi.
 *
 * @param {Array<{login:string, startedAt?:number, watchedMs?:number}>} chaines
 */
export function rankForStreak(chaines, ctx = {}) {
  const liste = (chaines || []).filter((c) => c?.login);

  const eligibles = liste
    .filter((c) => streakReachable(c, ctx))
    // La plus fraîche d'abord : c'est celle sur laquelle il reste le plus de
    // temps pour atteindre les six minutes.
    .sort((a, b) => Number(b.startedAt) - Number(a.startedAt));

  const eligiblesSet = new Set(eligibles.map((c) => c.login));
  const reste = liste.filter((c) => !eligiblesSet.has(c.login));

  return [...eligibles, ...reste].map((c) => c.login);
}
