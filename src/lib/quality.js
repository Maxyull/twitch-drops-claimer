// Picking an entry in the Twitch player's quality menu.
//
// The menu is the only reliable path: `localStorage` is just a preference the
// player reads at load time, and it does not always read it.
//
// Pure module: it only ever sees labels, never the DOM.

export const AUDIO_ONLY = "audio_only";

/**
 * Twitch names the image-less entry "Audio Only", "Audio seulement",
 * "Nur Audio"... The shared word is the same everywhere, and no other menu
 * entry contains it: "Auto", "Source", "720p60".
 */
export function isAudioLabel(label) {
  return /audio/i.test(String(label ?? ""));
}

/**
 * Which entry to click, by its position in the menu.
 *
 * Careful: audio only is the LAST of the list. Picking "the last one" to save
 * bandwidth therefore cut the image without meaning to, on every channel that
 * offers it. Hence this explicit choice.
 *
 * @param {string[]} labels  menu labels, in display order
 * @param {string}   wanted  requested quality
 * @returns {number} index to click, -1 when there is nothing sensible to click
 */
export function chooseQualityIndex(labels, wanted) {
  const list = Array.isArray(labels) ? labels.map((l) => String(l ?? "")) : [];
  if (!list.length) return -1;

  const audio = list.findIndex(isAudioLabel);
  // Requested but not offered by the channel: touch nothing rather than
  // degrading at random.
  if (wanted === AUDIO_ONLY) return audio;

  // Otherwise the lowest one that keeps an image, so the one just before audio only.
  const derniere = audio === -1 ? list.length - 1 : audio - 1;
  return derniere >= 0 ? derniere : -1;
}
