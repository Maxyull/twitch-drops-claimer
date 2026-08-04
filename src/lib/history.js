// The claim log.
//
// Counters say how many, never what or when. A counter at zero does not even
// let you tell "nothing was claimed" from "the information was lost": that is
// exactly the question that prompted this file.
//
// Pure module.

export const HISTORY_KIND = { DROP: "drop", POINTS: "points" };

/** Enough to cover several days of farming, without bloating storage. */
export const MAX_HISTORY = 200;

/**
 * @param {object} entry { kind, label, campaign, channel }
 * @param {number} at timestamp
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
 * Adds entries, most recent first.
 * Drops carry an id: they are written once only, otherwise a replayed reading
 * would fill the log with duplicates.
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

  // Descending: the latest claim reads without scrolling.
  const fusion = [...nouvelles, ...current].sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  return fusion.slice(0, max);
}

/** Counts entries of one kind, to cross-check against the counters. */
export function countKind(list, kind) {
  return (Array.isArray(list) ? list : []).filter((e) => e?.kind === kind).length;
}
