// Compter les drops réellement obtenus, et non les boutons que l'extension a
// cliqués. Twitch peut créditer un drop sans nous, et un clic peut échouer :
// dans les deux cas un compteur de clics ment. La source de vérité est
// l'inventaire, qui dit `isClaimed` pour chaque palier.
//
// Module pur.

/** Identifiants des paliers marqués comme obtenus par Twitch. */
export function collectClaimedIds(campaigns) {
  const ids = [];
  for (const campaign of campaigns || []) {
    for (const drop of campaign?.drops || []) {
      if (drop?.isClaimed && drop.id) ids.push(drop.id);
    }
  }
  return ids;
}

/**
 * Fusionne ce que Twitch dit avec ce qu'on savait déjà.
 *
 * Le premier passage est une simple prise d'empreinte : tout ce qui est déjà
 * obtenu est absorbé sans être compté, sinon le compteur afficherait d'un coup
 * l'historique complet du compte à l'installation.
 *
 * @param {string[]} known    identifiants déjà connus
 * @param {boolean} seeded    l'empreinte initiale a-t-elle été prise ?
 * @param {Array} campaigns   campagnes fraîchement lues
 * @returns {{ids: string[], added: string[]}}
 */
export function mergeClaimed(known, seeded, campaigns) {
  const set = new Set(Array.isArray(known) ? known : []);
  const added = [];

  for (const id of collectClaimedIds(campaigns)) {
    if (set.has(id)) continue;
    set.add(id);
    if (seeded) added.push(id);
  }

  return { ids: [...set], added };
}

/** Les campagnes expirent : on ne garde pas un historique sans fin. */
export const MAX_REMEMBERED = 2000;

export function trimRemembered(ids, max = MAX_REMEMBERED) {
  const list = Array.isArray(ids) ? ids : [];
  return list.length <= max ? list : list.slice(list.length - max);
}
