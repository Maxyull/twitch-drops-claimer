// Client GQL Twitch (lecture seule par défaut).
// On réutilise la session du navigateur : le jeton `auth-token` est le même que
// celui du site, on n'en crée ni n'en stocke aucun. Aucun mot de passe n'est lu.

const GQL_URL = "https://gql.twitch.tv/gql";
// Client-ID public du client web Twitch (visible dans n'importe quelle requête du site).
const CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";

export class GqlError extends Error {
  constructor(message, { status = null, kind = "gql" } = {}) {
    super(message);
    this.name = "GqlError";
    this.status = status;
    this.kind = kind;
  }
}

export async function getAuthToken() {
  const cookie = await chrome.cookies.get({
    url: "https://www.twitch.tv",
    name: "auth-token",
  });
  const value = cookie?.value?.trim();
  if (!value) {
    throw new GqlError("Pas de session Twitch : connecte-toi sur twitch.tv.", {
      kind: "auth",
    });
  }
  return value;
}

async function request(operationName, query, variables = {}) {
  const token = await getAuthToken();

  let res;
  try {
    res = await fetch(GQL_URL, {
      method: "POST",
      headers: {
        "Client-Id": CLIENT_ID,
        Authorization: `OAuth ${token}`,
        "Content-Type": "application/json",
      },
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

  if (payload?.errors?.length) {
    throw new GqlError(payload.errors.map((e) => e.message).join(" / "));
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

/** Réclamation directe (mode rapide, désactivé par défaut). */
export async function claimDrop(dropInstanceID) {
  if (!dropInstanceID) return null;
  const data = await request("TdcClaimDrop", M_CLAIM, { input: { dropInstanceID } });
  return data?.claimDropRewards?.status ?? null;
}
