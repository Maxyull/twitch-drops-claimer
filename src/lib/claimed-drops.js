// Count the drops actually obtained, not the buttons the extension clicked.
// Twitch can credit a drop without us, and a click can fail: either way a counter
// of clicks lies. The source of truth is the inventory, which says `isClaimed`
// for each tier.
//
// Pure module.

/** Ids of the tiers Twitch marks as obtained. */
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
 * Merges what Twitch says with what we already knew.
 *
 * The first pass is a plain snapshot: everything already obtained is absorbed
 * without being counted, otherwise the counter would display the account's whole
 * history at once on install.
 *
 * @param {string[]} known    ids already known
 * @param {boolean} seeded    has the initial snapshot been taken?
 * @param {Array} campaigns   freshly read campaigns
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

/** Campaigns expire: there is no point keeping an endless history. */
export const MAX_REMEMBERED = 2000;

export function trimRemembered(ids, max = MAX_REMEMBERED) {
  const list = Array.isArray(ids) ? ids : [];
  return list.length <= max ? list : list.slice(list.length - max);
}
