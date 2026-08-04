// "Required actions": the drops that call for something outside Twitch (linking
// the account on the publisher's site, going to collect the reward).
// The user ticks them off in the popup to say "done".
// Pure module.

import { needsAccountLink } from "./campaigns.js";

export const ACTION_KIND = {
  LINK: "link", // the Twitch account must be linked to the partner site
  REDEEM: "redeem", // drop collected, the reward is activated on the partner site
};

export function actionId(kind, campaignId, extra = "") {
  return [kind, campaignId, extra].filter(Boolean).join(":");
}

function baseAction(kind, campaign, now, extra = {}) {
  return {
    id: actionId(kind, campaign.id, extra.dropId),
    kind,
    campaignId: campaign.id,
    campaignName: campaign.name,
    game: campaign.gameName,
    url: campaign.accountLinkURL || campaign.detailsURL || "",
    endAt: campaign.endAt ?? null,
    done: false,
    doneAt: null,
    seenAt: now,
    ...extra,
  };
}

/**
 * Merges the actions already known with those derived from the campaigns.
 * Never loses the "ticked" state of an existing action.
 *
 * @returns {{list: Array, added: Array}}
 */
export function buildPendingActions(campaigns, existing = [], now = Date.now()) {
  const byId = new Map(existing.filter(Boolean).map((a) => [a.id, a]));
  const added = [];

  for (const campaign of campaigns || []) {
    if (!campaign?.id) continue;
    if (!needsAccountLink(campaign)) continue;

    const action = baseAction(ACTION_KIND.LINK, campaign, now);
    if (!byId.has(action.id)) {
      byId.set(action.id, action);
      added.push(action);
    }
  }

  return { list: [...byId.values()], added };
}

/**
 * The action created when a drop is claimed on a campaign whose reward is
 * collected on a partner site.
 */
export function redeemAction(campaign, drop, now = Date.now()) {
  if (!campaign?.id || !campaign.accountLinkURL) return null;
  return baseAction(ACTION_KIND.REDEEM, campaign, now, {
    dropId: drop?.id ?? "",
    dropName: drop?.name ?? "",
  });
}

export function addAction(list = [], action) {
  if (!action) return list;
  if (list.some((a) => a.id === action.id)) return list;
  return [...list, action];
}

export function setDone(list = [], id, done = true, now = Date.now()) {
  return list.map((a) =>
    a.id === id ? { ...a, done, doneAt: done ? now : null } : a,
  );
}

export function openActions(list = []) {
  return list.filter((a) => a && !a.done);
}

export function countOpen(list = []) {
  return openActions(list).length;
}

/** Campaigns the user has declared linked by hand. */
export function linkedOverrides(list = []) {
  return list
    .filter((a) => a && a.kind === ACTION_KIND.LINK && a.done)
    .map((a) => a.campaignId);
}

/**
 * Cleanup: drop the actions ticked more than 7 days ago, and those whose campaign
 * ended more than 2 days ago.
 */
export function pruneActions(list = [], now = Date.now()) {
  const WEEK = 7 * 24 * 60 * 60 * 1000;
  const TWO_DAYS = 2 * 24 * 60 * 60 * 1000;
  return list.filter((a) => {
    if (!a) return false;
    if (a.done && a.doneAt && now - a.doneAt > WEEK) return false;
    if (a.endAt && now - a.endAt > TWO_DAYS) return false;
    return true;
  });
}
