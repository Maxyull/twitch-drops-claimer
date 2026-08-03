// Voyant vert / rouge : est-ce que l'onglet en arrière-plan regarde VRAIMENT ?
// Module pur : on ne juge que sur les battements de coeur envoyés par le lecteur.
// Aucun libellé ici, uniquement des codes : les vues traduisent via les clés
// `status_*` de _locales.

export const BEAT_TIMEOUT_MS = 25_000;

export const STATUS = {
  OK: "ok",
  ADS: "ads",
  STALLED: "stalled",
  PAUSED: "paused",
  OFFLINE: "offline",
  NO_BEAT: "no_beat",
  NO_TAB: "no_tab",
  WRONG_CHANNEL: "wrong_channel",
  DISABLED: "disabled",
};

/** Un statut vert compte le temps de visionnage, un rouge non. */
export function isGreen(code) {
  return code === STATUS.OK || code === STATUS.ADS;
}

/**
 * @param {object|null} beat        dernier battement reçu
 * @param {object|null} prevBeat    battement précédent (pour détecter un flux figé)
 * @param {object} ctx  { now, expectedChannel, tabExists, enabled }
 * @returns {{code:string, green:boolean, channel:string|null, age:number|null}}
 */
export function evaluateBeat(beat, prevBeat, ctx = {}) {
  const { now = Date.now(), expectedChannel = null, tabExists = true, enabled = true } = ctx;

  const build = (code, channel = beat?.channel ?? null, age = null) => ({
    code,
    green: isGreen(code),
    channel,
    age,
  });

  if (!enabled) return build(STATUS.DISABLED, null);
  if (!tabExists) return build(STATUS.NO_TAB, null);
  if (!beat) return build(STATUS.NO_BEAT, null);

  const age = now - (beat.at ?? 0);
  if (age > BEAT_TIMEOUT_MS) return build(STATUS.NO_BEAT, beat.channel ?? null, age);

  if (expectedChannel && beat.channel && beat.channel !== expectedChannel) {
    return build(STATUS.WRONG_CHANNEL, beat.channel, age);
  }

  if (beat.offline) return build(STATUS.OFFLINE, beat.channel, age);
  if (beat.ads) return build(STATUS.ADS, beat.channel, age);
  if (beat.paused) return build(STATUS.PAUSED, beat.channel, age);

  // Le lecteur se dit en lecture : on vérifie que l'horloge de la vidéo avance
  // réellement entre deux battements, sinon c'est un flux figé.
  if (prevBeat && prevBeat.at !== beat.at && typeof beat.currentTime === "number") {
    if (beat.currentTime <= (prevBeat.currentTime ?? -1)) return build(STATUS.STALLED, beat.channel, age);
  }

  return build(STATUS.OK, beat.channel, age);
}

/** Synthèse pour la pastille de la barre d'outils. */
export function summarize(states = []) {
  const active = states.filter((s) => s && s.code !== STATUS.DISABLED);
  if (!active.length) return { green: false, code: STATUS.DISABLED };
  const bad = active.find((s) => !s.green);
  return bad ? { ...bad } : { ...active[0], code: STATUS.OK, green: true };
}
