// Tab navigation for the popup.
//
// The logic lives here, pure, because a keyboard that misbehaves in a tab bar is
// exactly the kind of defect nobody catches by hand: you have to test the edges
// (first and last) and the wrap-around.
//
// The pattern is the ARIA one: arrows move between tabs, Home and End jump to the
// ends, and only one tab is reachable with Tab.

export const TABS = ["live", "history", "campaigns"];

export const DEFAULT_TAB = "live";

/** A value coming from storage is not trusted. */
export function normalizeTab(value, fallback = DEFAULT_TAB) {
  return TABS.includes(value) ? value : fallback;
}

/**
 * The tab a key targets, or `null` when the key is none of our business.
 * Wrapping around is intentional: at the last tab, the right arrow returns to
 * the first.
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

// --- claim log filter -----------------------------------------------------

export const HISTORY_FILTERS = ["all", "drop", "points"];

export function normalizeFilter(value) {
  return HISTORY_FILTERS.includes(value) ? value : "all";
}

/**
 * The filtered log. One log rather than one per kind: the question you ask in
 * the morning is "what happened overnight", and it mixes both in time order.
 */
export function filterHistory(list, filter) {
  const entries = Array.isArray(list) ? list.filter(Boolean) : [];
  const f = normalizeFilter(filter);
  return f === "all" ? entries : entries.filter((e) => e.kind === f);
}
