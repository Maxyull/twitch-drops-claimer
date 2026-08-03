// Client GQL Twitch (lecture seule par défaut).
//
// Twitch protège cette API par un jeton d'intégrité que seul son propre JavaScript
// sait calculer. On ne le fabrique pas : on réutilise les en-têtes que la page
// Twitch envoie déjà, capturés par `header-capture.js`. Conséquence directe,
// l'extension a besoin d'au moins un onglet Twitch ouvert pour interroger l'API,
// et elle n'a plus besoin de lire le moindre cookie.

import { buildRequestHeaders } from "../lib/gql-headers.js";
import { getUsableHeaders } from "./header-capture.js";

const GQL_URL = "https://gql.twitch.tv/gql";

export class GqlError extends Error {
  constructor(message, { status = null, kind = "gql" } = {}) {
    super(message);
    this.name = "GqlError";
    this.status = status;
    this.kind = kind;
  }
}

async function request(operationName, query, variables = {}) {
  const captured = await getUsableHeaders();
  if (!captured) {
    throw new GqlError(
      "En attente d'un onglet Twitch : l'extension y récupère le jeton d'intégrité exigé par l'API.",
      { kind: "integrity" },
    );
  }

  let res;
  try {
    res = await fetch(GQL_URL, {
      method: "POST",
      headers: buildRequestHeaders(captured),
      body: JSON.stringify({ operationName, query, variables }),
    });
  } catch (cause) {
    throw new GqlError(`Réseau injoignable (${cause.message})`, { kind: "network" });
  }

  if (res.status === 401 || res.status === 403) {
    throw new GqlError("Session Twitch refusée : reconnecte-toi sur twitch.tv.", {
      status: res.status,
      kind: "auth",
    });
  }
  if (!res.ok) {
    throw new GqlError(`Twitch a répondu ${res.status}`, { status: res.status });
  }

  const json = await res.json();
  const payload = Array.isArray(json) ? json[0] : json;

  const failure = payload?.errors?.length
    ? payload.errors.map((e) => e.message).join(" / ")
    : typeof payload?.error === "string"
      ? payload.error
      : null;

  if (failure) {
    // Le jeton capturé a expiré : on le jette pour forcer une nouvelle capture.
    if (/integrity/i.test(failure)) {
      await chrome.storage.session.remove("gqlHeaders");
      throw new GqlError(
        "Jeton d'intégrité périmé, il sera repris sur le prochain chargement d'une page Twitch.",
        { kind: "integrity" },
      );
    }
    throw new GqlError(failure);
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
    stream { id viewersCount game { id slug } }
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

export async function currentUser() {
  const data = await request("TdcCurrentUser", Q_CURRENT_USER);
  return data?.currentUser ?? null;
}

/** Campagnes visibles par le compte (sans le détail des paliers). */
export async function campaignList() {
  const data = await request("TdcCampaignList", Q_CAMPAIGN_LIST);
  return data?.currentUser?.dropCampaigns ?? [];
}

/** Détail d'une campagne (paliers + chaînes autorisées). `channelLogin` = le login du compte. */
export async function campaignDetails(channelLogin, dropID) {
  const data = await request("TdcCampaignDetails", Q_CAMPAIGN_DETAILS, {
    channelLogin,
    dropID,
  });
  return data?.user?.dropCampaign ?? null;
}

/** Campagnes déjà entamées, avec la progression exacte. */
export async function inventory() {
  const data = await request("TdcInventory", Q_INVENTORY);
  return data?.currentUser?.inventory?.dropCampaignsInProgress ?? [];
}

/** Sous-ensemble des logins réellement en direct. */
export async function liveLogins(logins) {
  const list = (logins || []).filter(Boolean).slice(0, 100);
  if (!list.length) return [];
  const data = await request("TdcLive", Q_LIVE, { logins: list });
  return (data?.users ?? [])
    .filter((u) => u?.stream?.id)
    .map((u) => u.login.toLowerCase());
}

/** Un live de la catégorie avec les drops activés (le plus regardé d'abord). */
export async function gameDropStreams(slug, limit = 10) {
  if (!slug) return [];
  const data = await request("TdcGameStreams", Q_GAME_STREAMS, { slug, limit });
  return (data?.game?.streams?.edges ?? [])
    .map((e) => e?.node?.broadcaster?.login)
    .filter(Boolean)
    .map((l) => l.toLowerCase());
}

/**
 * Solde de points de chaîne sur une chaîne, et bonus en attente s'il y en a un.
 * C'est la seule façon de savoir ce que le visionnage rapporte vraiment : compter
 * les coffres cliqués ne dit rien du solde.
 */
export async function channelPoints(login) {
  if (!login) return null;
  const data = await request("TdcChannelPoints", Q_POINTS, { login });
  const community = data?.community;
  const points = community?.channel?.self?.communityPoints;
  if (!points) return null;

  return {
    balance: Number(points.balance) || 0,
    // Identifiant du coffre en attente. C'est lui qui permet de le réclamer
    // sans dépendre du DOM de Twitch.
    claimId: points.availableClaim?.id ?? null,
    channelId: community.channel?.id ?? community.id ?? null,
  };
}

/**
 * Réclame le bonus de points en attente.
 * @returns {{ok: boolean, error: string|null}}
 */
export async function claimCommunityPoints(channelId, claimId) {
  if (!channelId || !claimId) return { ok: false, error: "identifiants manquants" };
  const data = await request("TdcClaimPoints", M_CLAIM_POINTS, {
    input: { channelID: String(channelId), claimID: String(claimId) },
  });
  const error = data?.claimCommunityPoints?.error?.code ?? null;
  return { ok: !error, error };
}

/** Réclamation directe (mode rapide, désactivé par défaut). */
export async function claimDrop(dropInstanceID) {
  if (!dropInstanceID) return null;
  const data = await request("TdcClaimDrop", M_CLAIM, { input: { dropInstanceID } });
  return data?.claimDropRewards?.status ?? null;
}
