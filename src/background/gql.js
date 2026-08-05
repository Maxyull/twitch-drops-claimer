// Twitch GQL client (read-only by default).
//
// Twitch protects this API with an integrity token only its own JavaScript can
// compute. We do not forge it: we reuse the headers the Twitch page already
// sends, captured by `header-capture.js`. Direct consequence, the extension needs
// at least one open Twitch tab to query the API, and it no longer needs to read a
// single cookie.
//
// A thrown `GqlError` carries two things: `message`, English and for a developer,
// and `kind`, which the view turns into a translated sentence through
// `src/lib/errors.js`. Never write a user-facing sentence here (#76).

import { buildRequestHeaders } from "../lib/gql-headers.js";
import { getUsableHeaders } from "./header-capture.js";

const GQL_URL = "https://gql.twitch.tv/gql";

/**
 * `message` is for a developer: it lands in the console and in a stack trace, and
 * it stays English. What a user reads comes from `kind` plus `params`, translated
 * by the view through `src/lib/errors.js` (see #76).
 */
export class GqlError extends Error {
  constructor(message, { status = null, kind = "gql", params = [] } = {}) {
    super(message);
    this.name = "GqlError";
    this.status = status;
    this.kind = kind;
    this.params = params;
  }
}

async function request(operationName, query, variables = {}) {
  return send({ operationName, query, variables });
}

/**
 * "Persisted" query: Twitch accepts the fingerprint of a query registered on its
 * side instead of its text. That is what its own site does, and it is the only
 * way to call an operation whose exact signature is unknown, such as
 * `DropCurrentSessionContext`.
 *
 * A fingerprint can be retired by Twitch: the API then answers
 * `PersistedQueryNotFound`. `kind: "persisted"` lets the caller recognise it and
 * fall back to the normal path rather than keep insisting.
 */
async function requestPersisted(operationName, sha256Hash, variables = {}) {
  try {
    return await send({
      operationName,
      variables,
      extensions: { persistedQuery: { version: 1, sha256Hash } },
    });
  } catch (err) {
    // Deliberately narrow: a plain "not found" would also match unrelated errors
    // and would cut live progress off for nothing.
    if (err instanceof GqlError && /persisted\s*query/i.test(err.message)) {
      throw new GqlError(`query ${operationName} retired by Twitch (${err.message})`, {
        kind: "persisted",
        params: [operationName],
      });
    }
    throw err;
  }
}

async function send(body) {
  const captured = await getUsableHeaders();
  if (!captured) {
    throw new GqlError("no usable integrity headers captured yet", { kind: "integrity" });
  }

  let res;
  try {
    res = await fetch(GQL_URL, {
      method: "POST",
      headers: buildRequestHeaders(captured),
      body: JSON.stringify(body),
    });
  } catch (cause) {
    throw new GqlError(`network unreachable (${cause.message})`, {
      kind: "network",
      params: [cause.message],
    });
  }

  if (res.status === 401 || res.status === 403) {
    throw new GqlError(`Twitch refused the session (HTTP ${res.status})`, {
      status: res.status,
      kind: "auth",
    });
  }
  if (!res.ok) {
    throw new GqlError(`Twitch answered HTTP ${res.status}`, {
      status: res.status,
      kind: "http",
      params: [String(res.status)],
    });
  }

  const json = await res.json();
  const payload = Array.isArray(json) ? json[0] : json;

  const failure = payload?.errors?.length
    ? payload.errors.map((e) => e.message).join(" / ")
    : typeof payload?.error === "string"
      ? payload.error
      : null;

  if (failure) {
    // The captured token has expired: throw it away to force a fresh capture.
    if (/integrity/i.test(failure)) {
      await chrome.storage.session.remove("gqlHeaders");
      throw new GqlError("captured integrity token expired", { kind: "integrity_stale" });
    }
    // Twitch's own wording. We cannot translate it, so it is quoted rather than
    // shown bare: the sentence around it is translated and says where it comes
    // from. That is the open question #76 left, settled here.
    throw new GqlError(failure, { kind: "twitch", params: [failure] });
  }

  return payload?.data ?? {};
}

const Q_CURRENT_USER = `
query TdcCurrentUser {
  currentUser { id login displayName }
}`;

const Q_CAMPAIGN_LIST = `
query TdcCampaignList {
  currentUser {
    dropCampaigns {
      id
      name
      status
      startAt
      endAt
      detailsURL
      accountLinkURL
      self { isAccountConnected }
      game { id slug displayName }
    }
  }
}`;

const Q_CAMPAIGN_DETAILS = `
query TdcCampaignDetails($channelLogin: String!, $dropID: ID!) {
  user(login: $channelLogin) {
    dropCampaign(id: $dropID) {
      id
      name
      status
      startAt
      endAt
      detailsURL
      accountLinkURL
      self { isAccountConnected }
      game { id slug displayName }
      allow { isEnabled channels { id name displayName } }
      timeBasedDrops {
        id
        name
        requiredMinutesWatched
        benefitEdges { benefit { id name imageAssetURL } }
        self { isClaimed currentMinutesWatched dropInstanceID }
      }
    }
  }
}`;

const Q_INVENTORY = `
query TdcInventory {
  currentUser {
    inventory {
      dropCampaignsInProgress {
        id
        name
        status
        startAt
        endAt
        detailsURL
        accountLinkURL
        self { isAccountConnected }
        game { id slug displayName }
        allow { isEnabled channels { id name displayName } }
        timeBasedDrops {
          id
          name
          requiredMinutesWatched
          benefitEdges { benefit { id name imageAssetURL } }
          self { isClaimed currentMinutesWatched dropInstanceID }
        }
      }
    }
  }
}`;

const Q_LIVE = `
query TdcLive($logins: [String!]) {
  users(logins: $logins) {
    id
    login
    displayName
    stream { id viewersCount createdAt game { id slug } }
  }
}`;

const Q_GAME_STREAMS = `
query TdcGameStreams($slug: String!, $limit: Int!) {
  game(slug: $slug) {
    id
    displayName
    streams(first: $limit, options: {
      includeRestricted: [SUB_ONLY_LIVE],
      systemFilters: [DROPS_ENABLED],
      sort: VIEWER_COUNT
    }) {
      edges { node { id viewersCount broadcaster { id login displayName } } }
    }
  }
}`;

const Q_POINTS = `
query TdcChannelPoints($login: String!) {
  community(name: $login) {
    id
    channel {
      id
      self {
        communityPoints { balance availableClaim { id } }
      }
    }
  }
}`;

const M_CLAIM_POINTS = `
mutation TdcClaimPoints($input: ClaimCommunityPointsInput!) {
  claimCommunityPoints(input: $input) {
    error { code }
  }
}`;

const M_CLAIM = `
mutation TdcClaimDrop($input: ClaimDropRewardsInput!) {
  claimDropRewards(input: $input) { status }
}`;

const M_JOIN_RAID = `
mutation TdcJoinRaid($input: JoinRaidInput!) {
  joinRaid(input: $input) { raidID }
}`;

export async function currentUser() {
  const data = await request("TdcCurrentUser", Q_CURRENT_USER);
  return data?.currentUser ?? null;
}

/** Campaigns visible to the account (without the tier details). */
export async function campaignList() {
  const data = await request("TdcCampaignList", Q_CAMPAIGN_LIST);
  return data?.currentUser?.dropCampaigns ?? [];
}

/** A campaign's details (tiers + allowed channels). `channelLogin` = the account's login. */
export async function campaignDetails(channelLogin, dropID) {
  const data = await request("TdcCampaignDetails", Q_CAMPAIGN_DETAILS, {
    channelLogin,
    dropID,
  });
  return data?.user?.dropCampaign ?? null;
}

/** Campaigns already started, with their exact progress. */
export async function inventory() {
  const data = await request("TdcInventory", Q_INVENTORY);
  return data?.currentUser?.inventory?.dropCampaignsInProgress ?? [];
}

/** Channels actually live, with their id. */
export async function liveChannels(logins) {
  const list = (logins || []).filter(Boolean).slice(0, 100);
  if (!list.length) return [];
  const data = await request("TdcLive", Q_LIVE, { logins: list });
  return (data?.users ?? [])
    .filter((u) => u?.stream?.id && u?.login)
    .map((u) => ({
      login: u.login.toLowerCase(),
      id: u.id ?? null,
      // Since when the stream has been open: that is what says whether the streak
      // bonus is still reachable. `null` = information absent, not "old".
      startedAt: Date.parse(u.stream?.createdAt ?? "") || null,
    }));
}

/** The subset of logins that are actually live. */
export async function liveLogins(logins) {
  return (await liveChannels(logins)).map((c) => c.login);
}

/**
 * Progress of the drop Twitch is counting RIGHT NOW on a channel.
 *
 * The inventory says where every campaign stands; this query says which tier is
 * really advancing, right now, and by how much. It is the source TwitchDropsMiner
 * and Twitch-Channel-Points-Miner use: far lighter than the full inventory, and
 * therefore cheap enough to query every minute.
 *
 * Public fingerprint of the operation, exactly as Twitch's own site sends it.
 * It is not a secret: it is the identifier of a registered query.
 */
export const OP_CURRENT_DROP = {
  name: "DropCurrentSessionContext",
  hash: "4d06b702d25d652afb9ef835d2a550031f1cf762b193523a92166f40ea3d142b",
};

export async function currentDropSession(channelId) {
  if (!channelId) return null;
  const data = await requestPersisted(OP_CURRENT_DROP.name, OP_CURRENT_DROP.hash, {
    // `channelLogin` is expected by the operation and always empty on Twitch's side.
    channelID: String(channelId),
    channelLogin: "",
  });

  const session = data?.currentUser?.dropCurrentSession;
  if (!session?.dropID) return null;

  return {
    dropID: session.dropID,
    watchedMinutes: Number(session.currentMinutesWatched) || 0,
    requiredMinutes: Number(session.requiredMinutesWatched) || 0,
  };
}

/** A live stream in the category with drops enabled (most watched first). */
export async function gameDropStreams(slug, limit = 10) {
  if (!slug) return [];
  const data = await request("TdcGameStreams", Q_GAME_STREAMS, { slug, limit });
  return (data?.game?.streams?.edges ?? [])
    .map((e) => e?.node?.broadcaster?.login)
    .filter(Boolean)
    .map((l) => l.toLowerCase());
}

/**
 * Channel points balance on a channel, and the pending bonus if there is one.
 * This is the only way to know what the viewing really earns: counting the chests
 * clicked says nothing about the balance.
 */
export async function channelPoints(login) {
  if (!login) return null;
  const data = await request("TdcChannelPoints", Q_POINTS, { login });
  const community = data?.community;
  const points = community?.channel?.self?.communityPoints;
  if (!points) return null;

  return {
    balance: Number(points.balance) || 0,
    // Id of the pending chest. It is what allows claiming it without depending
    // on Twitch's DOM.
    claimId: points.availableClaim?.id ?? null,
    channelId: community.channel?.id ?? community.id ?? null,
  };
}

/**
 * Claims the pending points bonus.
 * @returns {{ok: boolean, error: string|null}}
 */
export async function claimCommunityPoints(channelId, claimId) {
  if (!channelId || !claimId) return { ok: false, error: "missing ids" };
  const data = await request("TdcClaimPoints", M_CLAIM_POINTS, {
    input: { channelID: String(channelId), claimID: String(claimId) },
  });
  const error = data?.claimCommunityPoints?.error?.code ?? null;
  return { ok: !error, error };
}

/**
 * Joins a raid in progress.
 *
 * Twitch pays a points bonus to the viewer who follows the raid. Without this
 * call the channel goes offline and the extension goes looking elsewhere: the
 * bonus is simply lost.
 */
export async function joinRaid(raidID) {
  if (!raidID) return { ok: false, error: "missing id" };
  const data = await request("TdcJoinRaid", M_JOIN_RAID, { input: { raidID: String(raidID) } });
  return { ok: Boolean(data?.joinRaid?.raidID), error: null };
}

/** Direct claim (fast mode, off by default). */
export async function claimDrop(dropInstanceID) {
  if (!dropInstanceID) return null;
  const data = await request("TdcClaimDrop", M_CLAIM, { input: { dropInstanceID } });
  return data?.claimDropRewards?.status ?? null;
}
