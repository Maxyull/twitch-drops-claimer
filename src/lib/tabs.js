// Navigation par onglets du popup.
//
// La logique est ici, pure, parce qu'un clavier qui tourne mal dans une barre
// d'onglets est le genre de défaut qu'on ne voit jamais à la main : il faut
// tester les bords (première et dernière), et le bouclage.
//
// Le motif est celui d'ARIA : flèches pour changer d'onglet, Origine et Fin
// pour aller aux extrémités, et un seul onglet atteignable par Tab.

export const TABS = ["live", "history", "campaigns"];

export const DEFAULT_TAB = "live";

/** Une valeur venue du stockage n'est pas de confiance. */
export function normalizeTab(value, fallback = DEFAULT_TAB) {
  return TABS.includes(value) ? value : fallback;
}

/**
 * Onglet visé par une touche, ou `null` si la touche ne nous concerne pas.
 * Le bouclage est voulu : arrivé au dernier, la flèche droite revient au premier.
 */
export function tabForKey(current, key, tabs = TABS) {
  const i = tabs.indexOf(current);
  if (i === -1) return null;

  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return tabs[(i + 1) % tabs.length];
    case "ArrowLeft":
    case "ArrowUp":
      return tabs[(i - 1 + tabs.length) % tabs.length];
    case "Home":
      return tabs[0];
    case "End":
      return tabs[tabs.length - 1];
    default:
      return null;
  }
}

// --- filtre du journal ----------------------------------------------------

export const HISTORY_FILTERS = ["all", "drop", "points"];

export function normalizeFilter(value) {
  return HISTORY_FILTERS.includes(value) ? value : "all";
}

/**
 * Le journal filtré. Un seul journal plutôt qu'un par type : la question qu'on
 * se pose le matin est « qu'est-ce qui s'est passé cette nuit », et elle
 * mélange les deux dans l'ordre du temps.
 */
export function filterHistory(list, filter) {
  const entries = Array.isArray(list) ? list.filter(Boolean) : [];
  const f = normalizeFilter(filter);
  return f === "all" ? entries : entries.filter((e) => e.kind === f);
}
