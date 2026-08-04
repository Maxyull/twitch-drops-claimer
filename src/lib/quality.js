// Choix d'une entrée dans le menu qualité du lecteur Twitch.
//
// Le menu est la seule voie fiable : `localStorage` n'est qu'une préférence que
// le lecteur relit au chargement, et il ne la relit pas toujours.
//
// Module pur : il ne voit que des libellés, pas le DOM.

export const AUDIO_ONLY = "audio_only";

/**
 * Twitch nomme l'entrée sans image « Audio Only », « Audio seulement »,
 * « Nur Audio »... Le mot commun est le même partout, et aucune autre entrée du
 * menu ne le contient : « Auto », « Source », « 720p60 ».
 */
export function isAudioLabel(label) {
  return /audio/i.test(String(label ?? ""));
}

/**
 * Quelle entrée cliquer, par sa position dans le menu.
 *
 * Attention : l'audio seul est le DERNIER de la liste. Choisir « la dernière »
 * pour économiser la bande passante revenait donc à couper l'image sans le
 * vouloir, sur les chaînes qui le proposent. D'où ce choix explicite.
 *
 * @param {string[]} labels  libellés du menu, dans l'ordre d'affichage
 * @param {string}   wanted  qualité demandée
 * @returns {number} index à cliquer, -1 s'il n'y a rien de sensé à cliquer
 */
export function chooseQualityIndex(labels, wanted) {
  const list = Array.isArray(labels) ? labels.map((l) => String(l ?? "")) : [];
  if (!list.length) return -1;

  const audio = list.findIndex(isAudioLabel);
  // Demandé mais pas proposé par la chaîne : on ne touche à rien plutôt que de
  // dégrader au hasard.
  if (wanted === AUDIO_ONLY) return audio;

  // Sinon la plus basse qui garde une image, donc celle juste avant l'audio seul.
  const derniere = audio === -1 ? list.length - 1 : audio - 1;
  return derniere >= 0 ? derniere : -1;
}
