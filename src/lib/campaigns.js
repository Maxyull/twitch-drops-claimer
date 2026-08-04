// Drop campaign model: reading GQL responses, progress, ranking.
// Pure module (no chrome API, no fetch) so it stays testable under Node.

export const DROP_STATE = {
  CLAIMED: "claimed", // already collected
  CLAIMABLE: "claimable", // time reached, button available
  IN_PROGRESS: "inProgress", // time being accumulated
  TODO: "todo", // nothing watched yet
};

function ms(value) {
  if (!value) return null;
  const t = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** GQL `DropCampaign` node -> internal model, tolerant of missing fields. */
export function parseCampaign(node) {
  if (!node || !node.id) return null;

  const drops = (node.timeBasedDrops || []).map((d) => ({
    id: d?.id ?? "",
    name: d?.name ?? "",
    requiredMinutes: num(d?.requiredMinutesWatched),
    watchedMinutes: num(d?.self?.currentMinutesWatched),
    isClaimed: Boolean(d?.self?.isClaimed),
    dropInstanceID: d?.self?.dropInstanceID ?? null,
    benefits: (d?.benefitEdges || [])
      .map((e) => e?.benefit)
      .filter(Boolean)
      .map((b) => ({ id: b.id, name: b.name ?? "", imageURL: b.imageAssetURL ?? "" })),
  }));

  return {
    id: node.id,
    name: node.name ?? "",
    status: node.status ?? "",
    startAt: ms(node.startAt),
    endAt: ms(node.endAt),
    gameId: node.game?.id ?? "",
    gameName: node.game?.displayName ?? "",
    gameSlug: node.game?.slug ?? "",
    detailsURL: node.detailsURL ?? "",
    accountLinkURL: node.accountLinkURL ?? "",
    // `null` = the query did not carry that information, not to be confused with `false`.
    isAccountConnected:
      typeof node.self?.isAccountConnected === "boolean" ? node.self.isAccountConnected : null,
    channels: (node.allow?.channels || [])
      .filter(Boolean)
      .map((c) => ({ id: c.id ?? "", login: (c.name ?? "").toLowerCase(), displayName: c.displayName ?? c.name ?? "" }))
      .filter((c) => c.login),
    drops,
  };
}

export function parseCampaigns(nodes) {
  return (nodes || []).map(parseCampaign).filter(Boolean);
}

/**
 * Carries progress from a fresh inventory onto already stored campaigns, without
 * touching their structure.
 *
 * The structure (tiers, rewards, allowed channels) is expensive to obtain and does
 * not move. Progress moves constantly and comes from a query `refreshWatchProof`
 * already makes. Separating the two avoids re-discovering the entire campaign
 * universe just to push a percentage up.
 *
 * A campaign missing from the inventory keeps what it had: the inventory only
 * lists what the account takes part in, and an absence is not a reset.
 */
export function mergeProgress(campaigns, fresh) {
  const parId = new Map((fresh || []).filter(Boolean).map((c) => [c.id, c]));
  if (!parId.size) return { campaigns: campaigns || [], changed: false };

  let changed = false;

  const fusionnees = (campaigns || []).map((campaign) => {
    const frais = parId.get(campaign?.id);
    if (!frais) return campaign;

    const parDrop = new Map((frais.drops || []).map((d) => [d.id, d]));
    let bouge = false;

    const drops = (campaign.drops || []).map((drop) => {
      const source = parDrop.get(drop.id);
      if (!source) return drop;
      if (
        source.watchedMinutes === drop.watchedMinutes &&
        source.isClaimed === drop.isClaimed &&
        source.dropInstanceID === drop.dropInstanceID
      ) {
        return drop;
      }
      bouge = true;
      return {
        ...drop,
        watchedMinutes: source.watchedMinutes,
        isClaimed: source.isClaimed,
        dropInstanceID: source.dropInstanceID,
      };
    });

    if (!bouge) return campaign;
    changed = true;
    return { ...campaign, drops };
  });

  return { campaigns: changed ? fusionnees : campaigns || [], changed };
}

/**
 * Carries the live progress of a single tier, the one Twitch is counting right
 * now on the watched channel.
 *
 * NEVER moves a counter backwards: the inventory and the live session do not
 * refresh at the same rate, and an older value arriving after a newer one would
 * pull the bar back down in front of the user. A tier does not lose minutes it
 * has already earned.
 */
export function applyLiveSession(campaigns, session) {
  const dropID = session?.dropID;
  const minutes = Number(session?.watchedMinutes);
  if (!dropID || !Number.isFinite(minutes)) return { campaigns: campaigns || [], changed: false };

  let changed = false;

  const fusionnees = (campaigns || []).map((campaign) => {
    if (!(campaign?.drops || []).some((d) => d.id === dropID)) return campaign;

    let bouge = false;
    const drops = campaign.drops.map((drop) => {
      if (drop.id !== dropID || minutes <= drop.watchedMinutes) return drop;
      bouge = true;
      return { ...drop, watchedMinutes: minutes };
    });

    if (!bouge) return campaign;
    changed = true;
    return { ...campaign, drops };
  });

  return { campaigns: changed ? fusionnees : campaigns || [], changed };
}

export function dropState(drop) {
  if (!drop) return DROP_STATE.TODO;
  if (drop.isClaimed) return DROP_STATE.CLAIMED;
  if (drop.dropInstanceID) return DROP_STATE.CLAIMABLE;
  if (drop.watchedMinutes >= drop.requiredMinutes && drop.requiredMinutes > 0) {
    return DROP_STATE.CLAIMABLE;
  }
  return drop.watchedMinutes > 0 ? DROP_STATE.IN_PROGRESS : DROP_STATE.TODO;
}

/**
 * A campaign's progress.
 * `remainingMinutes` = time left on the NEXT unearned tier, which is what ranks
 * "closest to done".
 */
export function campaignProgress(campaign) {
  const drops = campaign?.drops || [];
  let required = 0;
  let watched = 0;
  let claimable = 0;
  let claimed = 0;

  for (const d of drops) {
    required += d.requiredMinutes;
    watched += Math.min(d.watchedMinutes, d.requiredMinutes);
    const st = dropState(d);
    if (st === DROP_STATE.CLAIMABLE) claimable += 1;
    if (st === DROP_STATE.CLAIMED) claimed += 1;
  }

  const next = nextDrop(campaign);
  const remainingMinutes = next
    ? Math.max(0, next.requiredMinutes - next.watchedMinutes)
    : 0;

  return {
    total: drops.length,
    claimed,
    claimable,
    required,
    watched,
    pct: required > 0 ? Math.min(100, Math.round((watched / required) * 100)) : 0,
    remainingMinutes,
    done: drops.length > 0 && claimed === drops.length,
  };
}

/** Next tier to work on (unclaimed, not yet claimable), shortest first. */
export function nextDrop(campaign) {
  const pending = (campaign?.drops || [])
    .filter((d) => dropState(d) === DROP_STATE.IN_PROGRESS || dropState(d) === DROP_STATE.TODO)
    .sort((a, b) => a.requiredMinutes - b.requiredMinutes);
  return pending[0] || null;
}

/** Tiers ready to be claimed. */
export function claimableDrops(campaign) {
  return (campaign?.drops || []).filter((d) => dropState(d) === DROP_STATE.CLAIMABLE);
}

/** Does the campaign require linking the account on a partner site? */
export function needsAccountLink(campaign) {
  return Boolean(campaign?.accountLinkURL) && campaign.isAccountConnected === false;
}

export function isActive(campaign, now = Date.now()) {
  if (!campaign) return false;
  if (campaign.status && campaign.status !== "ACTIVE") return false;
  if (campaign.startAt && now < campaign.startAt) return false;
  if (campaign.endAt && now >= campaign.endAt) return false;
  return true;
}

/** Unbiased shuffle. The draw is injectable so the result can be tested. */
export function shuffle(items, random = Math.random) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Ranks the campaigns to farm, most important first.
 *
 * Two groups: the campaigns the user pushed to the front come first, among
 * themselves in expiry order. The rest follows, in the chosen order or at random
 * if asked for.
 *
 * Discards: inactive, finished, blacklisted, and (on request) those whose account
 * is not linked, unless the user ticked "done" (linkedOverrides).
 */
export function rankCampaigns(campaigns, options = {}) {
  const {
    now = Date.now(),
    strategy = "endingSoon",
    blacklist = [],
    focus = [],
    randomAfterFocus = false,
    random = Math.random,
    linkedOverrides = [],
    onlyLinkedCampaigns = false,
  } = options;

  const blocked = new Set(blacklist);
  const overridden = new Set(linkedOverrides);

  const eligible = (campaigns || []).filter((c) => {
    if (!c || blocked.has(c.id)) return false;
    if (!isActive(c, now)) return false;
    if (campaignProgress(c).done) return false;
    if (!nextDrop(c)) return false; // nothing left to accumulate
    if (onlyLinkedCampaigns && needsAccountLink(c) && !overridden.has(c.id)) return false;
    return true;
  });

  const order = new Map(eligible.map((c, i) => [c.id, i]));
  const focusSet = new Set(focus);

  const byEndAt = (a, b) => {
    const ea = a.endAt ?? Number.MAX_SAFE_INTEGER;
    const eb = b.endAt ?? Number.MAX_SAFE_INTEGER;
    return ea !== eb ? ea - eb : order.get(a.id) - order.get(b.id);
  };

  // The campaigns pushed to the front, among themselves by expiry date.
  const prioritaires = eligible.filter((c) => focusSet.has(c.id)).sort(byEndAt);
  const autres = eligible.filter((c) => !focusSet.has(c.id));

  if (randomAfterFocus) return [...prioritaires, ...shuffle(autres, random)];

  return [...prioritaires, ...autres.sort((a, b) => {
    if (strategy === "order") return order.get(a.id) - order.get(b.id);

    if (strategy === "closestToDone") {
      const d = campaignProgress(a).remainingMinutes - campaignProgress(b).remainingMinutes;
      if (d !== 0) return d;
    }

    // By default (and as a tie-break): whatever expires soonest.
    const ea = a.endAt ?? Number.MAX_SAFE_INTEGER;
    const eb = b.endAt ?? Number.MAX_SAFE_INTEGER;
    if (ea !== eb) return ea - eb;

    const ra = campaignProgress(a).remainingMinutes;
    const rb = campaignProgress(b).remainingMinutes;
    if (ra !== rb) return ra - rb;

    return order.get(a.id) - order.get(b.id);
  })];
}

/**
 * Picks the channel to watch for a campaign.
 * - allowlist of channels -> the first one that is live
 * - no allowlist -> null, and the caller goes looking for a live in the category
 */
export function pickChannel(campaign, liveLogins = []) {
  const live = new Set(liveLogins.map((l) => String(l).toLowerCase()));
  const allowed = campaign?.channels || [];
  if (!allowed.length) return null;
  const hit = allowed.find((c) => live.has(c.login));
  return hit ? hit.login : null;
}

/** true when the campaign accepts any live stream in the category. */
export function isCategoryWide(campaign) {
  return !(campaign?.channels || []).length;
}
