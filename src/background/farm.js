// Orchestrateur : quelles campagnes farmer, quelle chaîne regarder, quels onglets ouvrir.

import {
  parseCampaign,
  rankCampaigns,
  pickChannel,
  isCategoryWide,
  campaignProgress,
  isActive,
} from "../lib/campaigns.js";
import { buildPendingActions, linkedOverrides, pruneActions } from "../lib/actions.js";
import * as gql from "./gql.js";
import * as store from "../lib/storage.js";

const INVENTORY_URL = "https://www.twitch.tv/drops/inventory";
const DETAILS_PER_REFRESH = 20;
const DETAILS_TTL_MS = 6 * 60 * 60 * 1000;

// --- onglets --------------------------------------------------------------

async function anyWindowId() {
  // On filtre en JS plutôt que par `windowTypes`, déprécié dans getAll().
  const windows = (await chrome.windows.getAll()).filter((w) => w.type === "normal");
  if (windows.length) return windows[0].id;
  const created = await chrome.windows.create({ state: "minimized", focused: false });
  return created.id;
}

async function openBackgroundTab(url, { pinned = true } = {}) {
  const windowId = await anyWindowId();
  const tab = await chrome.tabs.create({ url, active: false, pinned, windowId });
  try {
    // Empêche Chrome de mettre l'onglet en veille : un onglet déchargé ne regarde plus rien.
    await chrome.tabs.update(tab.id, { autoDiscardable: false });
  } catch {
    /* option indisponible selon la version, sans conséquence */
  }
  return tab.id;
}

async function tabExists(tabId) {
  if (!tabId) return false;
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

async function closeTab(tabId) {
  if (!tabId) return;
  try {
    await chrome.tabs.remove(tabId);
  } catch {
    /* déjà fermé */
  }
}

/**
 * Ouvre ou recycle un onglet d'arrière-plan pointant sur une chaîne.
 * On mémorise la chaîne demandée plutôt que de relire l'adresse de l'onglet :
 * ça évite la permission "tabs" (cf. docs/AUDIT-SECU.md).
 */
async function ensureChannelTab(tabId, channel) {
  const url = `https://www.twitch.tv/${channel}`;
  const state = await store.getState();

  if (await tabExists(tabId)) {
    if (state.tabChannels[tabId] !== channel) {
      await chrome.tabs.update(tabId, { url });
      await store.setState({ tabChannels: { ...state.tabChannels, [tabId]: channel } });
    }
    return tabId;
  }

  const created = await openBackgroundTab(url);
  await store.setState({ tabChannels: { ...state.tabChannels, [created]: channel } });
  return created;
}

// --- campagnes ------------------------------------------------------------

async function getLogin() {
  const { twitchLogin } = await chrome.storage.local.get("twitchLogin");
  if (twitchLogin) return twitchLogin;
  const user = await gql.currentUser();
  if (!user?.login) throw new gql.GqlError("Compte Twitch introuvable.", { kind: "auth" });
  await chrome.storage.local.set({ twitchLogin: user.login });
  return user.login;
}

/**
 * Recharge la liste des campagnes.
 * L'inventaire donne la progression exacte des campagnes entamées ; la liste
 * générale donne les campagnes pas encore commencées, dont on va chercher le
 * détail au compte-gouttes (et qu'on met en cache).
 */
export async function refreshCampaigns() {
  const now = Date.now();
  const byId = new Map();

  for (const node of await gql.inventory()) {
    const parsed = parseCampaign(node);
    if (parsed) byId.set(parsed.id, parsed);
  }

  const cache = await store.getDetailsCache();
  let login = null;
  let fetched = 0;

  for (const node of await gql.campaignList()) {
    const shallow = parseCampaign(node);
    if (!shallow || byId.has(shallow.id)) continue;
    if (!isActive(shallow, now)) continue;

    const cached = cache[shallow.id];
    if (cached && now - cached.at < DETAILS_TTL_MS) {
      byId.set(shallow.id, {
        ...shallow,
        drops: cached.campaign.drops,
        channels: cached.campaign.channels,
      });
      continue;
    }

    if (fetched >= DETAILS_PER_REFRESH) {
      byId.set(shallow.id, shallow); // sans paliers : classée en dernier, mais visible
      continue;
    }

    try {
      login = login || (await getLogin());
      const detail = parseCampaign(await gql.campaignDetails(login, shallow.id));
      fetched += 1;
      if (detail) {
        byId.set(detail.id, detail);
        cache[detail.id] = { at: now, campaign: detail };
      } else {
        byId.set(shallow.id, shallow);
      }
    } catch {
      byId.set(shallow.id, shallow);
    }
  }

  for (const [id, entry] of Object.entries(cache)) {
    if (now - entry.at > DETAILS_TTL_MS * 4) delete cache[id];
  }
  await store.setDetailsCache(cache);

  const campaigns = [...byId.values()];
  await store.setCampaigns(campaigns);
  return campaigns;
}

/** Met à jour la liste « actions requises » et renvoie les nouvelles. */
export async function syncActions(campaigns, now = Date.now()) {
  const existing = pruneActions(await store.getActions(), now);
  const { list, added } = buildPendingActions(campaigns, existing, now);
  await store.setActions(list);
  return { list, added };
}

/**
 * Choisit quoi farmer : la campagne la mieux classée dont une chaîne est en direct.
 * @returns {{campaign: object, channel: string}|null}
 */
export async function pickTarget(campaigns, settings) {
  const actions = await store.getActions();
  const ranked = rankCampaigns(campaigns, {
    now: Date.now(),
    strategy: settings.priority,
    blacklist: settings.campaignBlacklist,
    linkedOverrides: linkedOverrides(actions),
    onlyLinkedCampaigns: settings.onlyLinkedCampaigns,
  });

  for (const campaign of ranked) {
    if (isCategoryWide(campaign)) {
      const streams = await gql.gameDropStreams(campaign.gameSlug, 10);
      if (streams.length) return { campaign, channel: streams[0] };
      continue;
    }

    const live = await gql.liveLogins(campaign.channels.map((c) => c.login));
    const channel = pickChannel(campaign, live);
    if (channel) return { campaign, channel };
  }

  return null;
}

// --- boucles d'entretien --------------------------------------------------

/** Onglet dédié aux points de chaîne, sur la première chaîne favorite en direct. */
export async function ensurePointsTab(settings) {
  const state = await store.getState();

  if (!settings.enabled || !settings.watchFavorite || !settings.favoriteChannels.length) {
    if (state.pointsTabId) await closeTab(state.pointsTabId);
    return store.setState({ pointsTabId: null, pointsChannel: null });
  }

  let live = [];
  try {
    live = await gql.liveLogins(settings.favoriteChannels);
  } catch {
    live = [];
  }

  // Sans info de direct (API muette), on garde la première favorite : le voyant
  // passera au rouge « chaîne hors ligne » et dira la vérité.
  let target = settings.favoriteChannels.find((c) => live.includes(c)) ?? settings.favoriteChannels[0];
  if (state.pointsChannel && live.includes(state.pointsChannel)) {
    target = state.pointsChannel; // ne pas zapper une favorite qui marche
  }

  const tabId = await ensureChannelTab(state.pointsTabId, target);
  return store.setState({ pointsTabId: tabId, pointsChannel: target });
}

/** Onglet dédié aux drops, qui suit la campagne prioritaire. */
export async function ensureDropsTab(settings, { force = false } = {}) {
  const state = await store.getState();

  if (!settings.enabled || !settings.farmDrops || !settings.autoDiscover) {
    if (state.dropsTabId) await closeTab(state.dropsTabId);
    return store.setState({
      dropsTabId: null,
      dropsChannel: null,
      dropsCampaignId: null,
      dropsSince: null,
    });
  }

  const { campaigns } = await store.getCampaigns();

  // Campagne en cours toujours valable et chaîne toujours en direct : on ne bouge pas.
  if (!force && state.dropsCampaignId && (await tabExists(state.dropsTabId))) {
    const current = campaigns.find((c) => c.id === state.dropsCampaignId);
    if (current && isActive(current) && !campaignProgress(current).done) {
      let live = [];
      try {
        live = await gql.liveLogins([state.dropsChannel]);
      } catch {
        live = [state.dropsChannel]; // API muette : on laisse tourner
      }
      if (live.includes(state.dropsChannel)) return state;
    }
  }

  const target = await pickTarget(campaigns, settings);
  if (!target) {
    if (state.dropsTabId) await closeTab(state.dropsTabId);
    return store.setState({
      dropsTabId: null,
      dropsChannel: null,
      dropsCampaignId: null,
      dropsSince: null,
    });
  }

  const tabId = await ensureChannelTab(state.dropsTabId, target.channel);
  return store.setState({
    dropsTabId: tabId,
    dropsChannel: target.channel,
    dropsCampaignId: target.campaign.id,
    dropsSince: Date.now(),
  });
}

/**
 * Passe de réclamation : ouvre (ou recharge) l'inventaire, le script de contenu
 * fait les clics et rapporte. En mode rapide, on réclame directement par l'API.
 */
export async function runClaimSweep(settings) {
  if (!settings.enabled) return { mode: "off", claimed: 0 };

  if (settings.fastClaim) {
    const { campaigns } = await store.getCampaigns();
    let claimed = 0;
    for (const campaign of campaigns) {
      for (const drop of campaign.drops) {
        if (drop.isClaimed || !drop.dropInstanceID) continue;
        try {
          await gql.claimDrop(drop.dropInstanceID);
          claimed += 1;
        } catch {
          /* on retentera au prochain passage */
        }
      }
    }
    return { mode: "api", claimed };
  }

  const state = await store.getState();
  if (await tabExists(state.inventoryTabId)) {
    await chrome.tabs.reload(state.inventoryTabId);
    return { mode: "dom", claimed: 0, tabId: state.inventoryTabId };
  }
  const tabId = await openBackgroundTab(INVENTORY_URL);
  await store.setState({ inventoryTabId: tabId });
  return { mode: "dom", claimed: 0, tabId };
}

/**
 * Ouvre un onglet Twitch quand il n'y en a aucun, uniquement pour que l'extension
 * puisse reprendre le jeton d'intégrité au passage. L'inventaire est le meilleur
 * candidat : c'est de toute façon la page dont on a besoin pour réclamer.
 */
export async function ensureHarvestTab() {
  const state = await store.getState();
  if (await tabExists(state.inventoryTabId)) return state;
  if (await tabExists(state.pointsTabId)) return state;
  if (await tabExists(state.dropsTabId)) return state;

  const tabId = await openBackgroundTab(INVENTORY_URL);
  return store.setState({ inventoryTabId: tabId });
}

export async function closeAllTabs() {
  const state = await store.getState();
  await Promise.all([
    closeTab(state.pointsTabId),
    closeTab(state.dropsTabId),
    closeTab(state.inventoryTabId),
  ]);
  return store.setState({
    pointsTabId: null,
    pointsChannel: null,
    dropsTabId: null,
    dropsChannel: null,
    dropsCampaignId: null,
    dropsSince: null,
    inventoryTabId: null,
    tabChannels: {},
  });
}

export { tabExists, closeTab, openBackgroundTab };
