// Journal des réclamations.
//
// Les compteurs disent combien, jamais quoi ni quand. Un compteur à zéro ne
// permet même pas de distinguer « rien n'a été réclamé » de « l'information
// a été perdue » : c'est exactement la question qui a motivé ce fichier.
//
// Module pur.

export const HISTORY_KIND = { DROP: "drop", POINTS: "points" };

/** Assez pour couvrir plusieurs jours de farm, sans faire enfler le stockage. */
export const MAX_HISTORY = 200;

/**
 * @param {object} entry { kind, label, campaign, channel }
 * @param {number} at horodatage
 */
export function makeEntry(entry, at = Date.now()) {
  const kind = entry?.kind === HISTORY_KIND.POINTS ? HISTORY_KIND.POINTS : HISTORY_KIND.DROP;
  return {
    at,
    kind,
    id: entry?.id ?? "",
    label: String(entry?.label ?? "").slice(0, 120),
    campaign: String(entry?.campaign ?? "").slice(0, 120),
    channel: String(entry?.channel ?? "").slice(0, 25),
  };
}

/**
 * Ajoute des entrées, les plus récentes en tête.
 * Les drops portent un identifiant : on ne les inscrit qu'une fois, sinon un
 * relevé rejoué gonflerait le journal de doublons.
 */
export function addEntries(list, entries, max = MAX_HISTORY) {
  const current = Array.isArray(list) ? list : [];
  const connus = new Set(current.filter((e) => e?.id).map((e) => e.id));

  const nouvelles = [];
  for (const entry of entries ?? []) {
    if (!entry) continue;
    if (entry.id && connus.has(entry.id)) continue;
    if (entry.id) connus.add(entry.id);
    nouvelles.push(entry);
  }

  if (!nouvelles.length) return current;

  // Tri décroissant : la dernière réclamation se lit sans faire défiler.
  const fusion = [...nouvelles, ...current].sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  return fusion.slice(0, max);
}

/** Compte les entrées d'un type, pour recouper avec les compteurs. */
export function countKind(list, kind) {
  return (Array.isArray(list) ? list : []).filter((e) => e?.kind === kind).length;
}
