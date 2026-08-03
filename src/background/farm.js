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
import { mergeClaimed, trimRemembered } from "../lib/claimed-drops.js";
import { progressAdvanced } from "../lib/counted.js";
import { mapLimited } from "../lib/concurrency.js";
import * as gql from "./gql.js";
import * as store from "../lib/storage.js";

const INVENTORY_URL = "https://www.twitch.tv/drops/inventory";
const DETAILS_TTL_MS = 6 * 60 * 60 * 1000;
/** Requêtes de détail en vol simultanément. Assez pour être rapide, pas assez pour agacer Twitch. */
const DETAILS_CONCURRENCY = 6;
/** Garde-fou : un compte ne voit jamais autant de campagnes, mais on ne boucle pas à l'infini. */
const MAX_DETAILS = 200;

// --- onglets --------------------------------------------------------------

async function normalWindows() {
  // On filtre en JS plutôt que par `windowTypes`, déprécié dans getAll().
  return (await chrome.windows.getAll()).filter((w) => w.type === "normal");
}

/**
 * Fenêtre où l'extension pose ses onglets.
 * En mode dédié, elle en garde une à elle, réduite : c'est ce qui permet
 * d'activer un onglet pour débloquer son lecteur sans jamais voler le focus de
 * la fenêtre dans laquelle l'utilisateur travaille.
 */
async function targetWindowId(settings) {
  const windows = await normalWindows();

  if (settings?.dedicatedWindow) {
    const state = await store.getState();
    if (state.windowId && windows.some((w) => w.id === state.windowId)) return state.windowId;

    const created = await chrome.windows.create({ state: "minimized", focused: false });
    await store.setState({ windowId: created.id });
    return created.id;
  }

  if (windows.length) return windows[0].id;
  const created = await chrome.windows.create({ state: "minimized", focused: false });
  return created.id;
}

/**
 * Sourdine au niveau de l'onglet, en plus de celle posée sur le lecteur par le
 * script de contenu. Ceinture et bretelles volontaires : si le script de contenu
 * ne se charge pas, Twitch démarre au volume enregistré par l'utilisateur et
 * l'onglet se met à parler tout seul.
 * Muter un onglet ne demande pas la permission "tabs", seule la lecture de son
 * URL la demanderait.
 */
async function applyTabMute(tabId, settings) {
  try {
    await chrome.tabs.update(tabId, { muted: Boolean(settings?.muteTabs) });
  } catch {
    /* pas de sourdine possible : le script de contenu coupe déjà le lecteur */
  }
}

async function openBackgroundTab(url, { pinned = true } = {}) {
  const settings = await store.getSettings();
  const windowId = await targetWindowId(settings);
  const tab = await chrome.tabs.create({ url, active: false, pinned, windowId });
  try {
    // Empêche Chrome de mettre l'onglet en veille : un onglet déchargé ne regarde plus rien.
    await chrome.tabs.update(tab.id, { autoDiscardable: false });
  } catch {
    /* option indisponible selon la version, sans conséquence */
  }
  await applyTabMute(tab.id, settings);
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
      await applyTabMute(tabId, await store.getSettings());
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
 * Recharge la liste des campagnes, en entier et en un seul passage.
 *
 * L'inventaire donne la progression exacte des campagnes entamées. La liste
 * générale donne toutes les autres, dont il faut aller chercher le détail
 * (paliers et chaînes autorisées) une par une : ce sont ces requêtes qu'on
 * parallélise, sinon la liste se remplirait sur plusieurs cycles.
 */
/**
 * La structure d'une campagne ne bouge pas : noms des paliers, minutes requises,
 * chaînes autorisées. Sa progression, si. Servir `isClaimed` depuis un cache de
 * six heures rendait invisible tout drop réclamé entre-temps, et le compteur
 * restait à zéro. Le cache garde donc la structure, jamais l'avancement.
 */
function forgetProgress(drops) {
  return (drops || []).map((d) => ({
    ...d,
    watchedMinutes: 0,
    isClaimed: false,
    dropInstanceID: null,
  }));
}

/** Campagnes entamées, avec leur progression réelle. Une seule requête. */
export async function inventoryCampaigns() {
  return (await gql.inventory()).map(parseCampaign).filter(Boolean);
}

export async function refreshCampaigns() {
  const now = Date.now();
  const byId = new Map();

  for (const campaign of await inventoryCampaigns()) byId.set(campaign.id, campaign);

  const cache = await store.getDetailsCache();
  const aChercher = [];

  for (const node of await gql.campaignList()) {
    const shallow = parseCampaign(node);
    if (!shallow || byId.has(shallow.id)) continue;
    if (!isActive(shallow, now)) continue;

    const cached = cache[shallow.id];
    if (cached && now - cached.at < DETAILS_TTL_MS) {
      byId.set(shallow.id, {
        ...shallow,
        drops: forgetProgress(cached.campaign.drops),
        channels: cached.campaign.channels,
      });
      continue;
    }
    aChercher.push(shallow);
  }

  if (aChercher.length) {
    const restants = aChercher.slice(0, MAX_DETAILS);
    const login = await getLogin();

    const details = await mapLimited(restants, DETAILS_CONCURRENCY, async (shallow) =>
      parseCampaign(await gql.campaignDetails(login, shallow.id)),
    );

    restants.forEach((shallow, i) => {
      const detail = details[i];
      if (detail) {
        byId.set(detail.id, detail);
        // On ne met en cache que la structure : stocker un avancement qu'on
        // s'interdit de relire ne ferait qu'occuper du quota.
        cache[detail.id] = { at: now, campaign: { ...detail, drops: forgetProgress(detail.drops) } };
      } else {
        // Détail indisponible : la campagne reste visible, sans ses paliers.
        byId.set(shallow.id, shallow);
      }
    });

    for (const shallow of aChercher.slice(MAX_DETAILS)) byId.set(shallow.id, shallow);
  }

  for (const [id, entry] of Object.entries(cache)) {
    if (now - entry.at > DETAILS_TTL_MS * 4) delete cache[id];
  }
  await store.setDetailsCache(cache);

  const campaigns = [...byId.values()];
  await store.setCampaigns(campaigns);
  return campaigns;
}

/**
 * Compte les drops réellement obtenus, d'après l'inventaire et non d'après nos
 * clics : Twitch peut créditer un palier sans nous, et un clic peut échouer.
 */
export async function syncClaimedDrops(campaigns) {
  const { ids, seeded } = await store.getClaimedDrops();
  const merged = mergeClaimed(ids, seeded, campaigns);
  await store.setClaimedDrops(trimRemembered(merged.ids));

  if (merged.added.length) await store.bumpStat("drops", "", merged.added.length);
  return merged.added.length;
}

/**
 * Preuve de comptage par la progression : les minutes accumulées sur la campagne
 * suivie et le solde de points de la chaîne favorite. C'est le signal le plus
 * lent à venir, et le seul qui ne puisse pas se tromper.
 */
const PROOF_TTL_MS = 5 * 60_000;

export async function refreshWatchProof() {
  const state = await store.getState();
  const now = Date.now();
  if (now - (state.proofCheckedAt ?? 0) < PROOF_TTL_MS) return state;

  const marks = { ...(state.marks ?? {}) };
  const proof = { ...(state.proof ?? {}) };

  if (state.dropsCampaignId) {
    try {
      const current = (await gql.inventory())
        .map(parseCampaign)
        .find((c) => c?.id === state.dropsCampaignId);
      const minutes = current ? campaignProgress(current).watched : null;

      if (typeof minutes === "number") {
        const memeCampagne = marks.dropsCampaignId === state.dropsCampaignId;
        if (memeCampagne && progressAdvanced(marks.dropsMinutes, minutes)) proof.dropsAt = now;
        marks.dropsCampaignId = state.dropsCampaignId;
        marks.dropsMinutes = minutes;
      }
    } catch {
      /* API muette : on retentera au prochain passage */
    }
  }

  const balance = state.pointsBalance;
  if (balance?.channel) {
    const memeChaine = marks.pointsChannel === balance.channel;
    if (memeChaine && progressAdvanced(marks.pointsBalance, balance.balance)) proof.pointsAt = now;
    marks.pointsChannel = balance.channel;
    marks.pointsBalance = balance.balance;
  }

  return store.setState({ proofCheckedAt: now, marks, proof });
}

/**
 * Solde de la chaîne suivie, et surtout réclamation du coffre en attente.
 *
 * Le clic dans le DOM reste en place pour les onglets que l'utilisateur ouvre
 * lui-même, mais il dépend d'une classe CSS de Twitch : le jour où elle change,
 * plus rien ne se réclame et rien ne le signale. L'API, elle, dit explicitement
 * qu'un bonus attend et confirme qu'il a été pris.
 */
const POINTS_TTL_MS = 60_000;

/**
 * Deux chemins réclament le même coffre : l'API et le clic dans le DOM. Sans
 * garde, le compteur compterait deux fois, ce qui est exactement le défaut qu'on
 * cherche à corriger. Un coffre apparaît toutes les quinze minutes environ :
 * une minute de fenêtre ne peut pas fusionner deux bonus légitimes.
 */
const POINTS_DEDUPE_MS = 60_000;

export async function recordPointsClaim(channel) {
  const state = await store.getState();
  const now = Date.now();

  if (state.lastPointsChannel === channel && now - (state.lastPointsAt ?? 0) < POINTS_DEDUPE_MS) {
    return false;
  }

  await store.setState({ lastPointsChannel: channel, lastPointsAt: now });
  await store.bumpStat("points", channel ?? "");
  return true;
}

export async function refreshPoints(settings) {
  const state = await store.getState();
  const channel = state.pointsChannel;
  if (!channel) return null;

  const cached = state.pointsBalance;
  if (cached?.channel === channel && Date.now() - cached.at < POINTS_TTL_MS) return cached;

  let points;
  try {
    points = await gql.channelPoints(channel);
  } catch {
    return cached ?? null; // API muette : on garde la dernière valeur connue
  }
  if (!points) return cached ?? null;

  const fresh = {
    channel,
    balance: points.balance,
    hasBonus: Boolean(points.claimId),
    at: Date.now(),
  };
  await store.setState({ pointsBalance: fresh });

  if (!settings?.claimPoints || !points.claimId) return fresh;
  // Le même coffre ne se réclame qu'une fois, même si on repasse dessus.
  if (state.claimedBonusId === points.claimId) return fresh;

  try {
    const res = await gql.claimCommunityPoints(points.channelId, points.claimId);
    if (!res.ok) return fresh;
  } catch {
    return fresh;
  }

  await store.setState({ claimedBonusId: points.claimId });
  const compte = await recordPointsClaim(channel);
  return { ...fresh, claimed: compte, channel };
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
    focus: settings.focusCampaigns,
    randomAfterFocus: settings.randomAfterFocus,
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

/**
 * Onglet dédié aux points de chaîne, sur la première chaîne favorite en direct.
 * Aucune favorite en direct : l'onglet ne sert plus à rien, on le ferme.
 */
export async function ensurePointsTab(settings) {
  const state = await store.getState();

  if (!settings.enabled || !settings.watchFavorite || !settings.favoriteChannels.length) {
    if (state.pointsTabId) await closeTab(state.pointsTabId);
    return store.setState({ pointsTabId: null, pointsChannel: null });
  }

  // `null` et `[]` ne veulent pas dire la même chose : l'un est une absence
  // d'information, l'autre une réponse. On ne ferme jamais un onglet sur une
  // information qu'on n'a pas.
  let live = null;
  try {
    live = await gql.liveLogins(settings.favoriteChannels);
  } catch {
    live = null;
  }

  if (live === null) {
    if (state.pointsChannel && (await tabExists(state.pointsTabId))) return state;
    const fallback = settings.favoriteChannels[0];
    const tabId = await ensureChannelTab(state.pointsTabId, fallback);
    return store.setState({ pointsTabId: tabId, pointsChannel: fallback });
  }

  if (!live.length) {
    if (state.pointsTabId) await closeTab(state.pointsTabId);
    return store.setState({ pointsTabId: null, pointsChannel: null });
  }

  // On ne zappe pas une favorite qui marche pour une autre mieux classée.
  const target = live.includes(state.pointsChannel)
    ? state.pointsChannel
    : settings.favoriteChannels.find((c) => live.includes(c));

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
    await store.setState({ inventorySince: Date.now() });
    return { mode: "dom", claimed: 0, tabId: state.inventoryTabId };
  }
  const tabId = await openBackgroundTab(INVENTORY_URL);
  await store.setState({ inventoryTabId: tabId, inventorySince: Date.now() });
  return { mode: "dom", claimed: 0, tabId };
}

/** Durée laissée à la page d'inventaire pour charger et cliquer avant fermeture. */
const INVENTORY_GRACE_MS = 90_000;

/**
 * L'inventaire n'a pas à rester ouvert entre deux passages. On ne le garde que
 * s'il est le seul onglet Twitch : il sert alors aussi à reprendre le jeton
 * d'intégrité, sans lequel plus rien ne fonctionne.
 */
export async function closeInventoryIfRedundant() {
  const state = await store.getState();
  if (!state.inventoryTabId) return state;
  if (Date.now() - (state.inventorySince ?? 0) < INVENTORY_GRACE_MS) return state;

  const stillNeeded =
    !(await tabExists(state.pointsTabId)) && !(await tabExists(state.dropsTabId));
  if (stillNeeded) return state;

  await closeTab(state.inventoryTabId);
  return store.setState({ inventoryTabId: null, inventorySince: null });
}

export async function reloadTab(tabId) {
  if (!(await tabExists(tabId))) return false;
  try {
    await chrome.tabs.reload(tabId);
    return true;
  } catch {
    return false;
  }
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

/**
 * Réveille un onglet dont le lecteur reste bloqué : on l'active dans SA fenêtre.
 * Si la fenêtre dédiée est utilisée, l'utilisateur ne voit rien passer, seule la
 * fenêtre réduite de l'extension change d'onglet actif.
 */
export async function wakeTab(tabId) {
  if (!(await tabExists(tabId))) return false;
  try {
    await chrome.tabs.update(tabId, { active: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Rassemble les onglets de l'extension dans la fenêtre cible.
 * @returns {{windowId: number, placed: number}}
 */
export async function regroupTabs(settings) {
  const state = await store.getState();
  const windowId = await targetWindowId(settings);
  const tabs = [state.pointsTabId, state.dropsTabId, state.inventoryTabId].filter(Boolean);
  let placed = 0;

  for (const tabId of tabs) {
    if (!(await tabExists(tabId))) continue;
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.windowId !== windowId) await chrome.tabs.move(tabId, { windowId, index: -1 });
      placed += 1;
    } catch {
      /* onglet disparu entre-temps */
    }
  }
  return { windowId, placed };
}

/**
 * Repart d'une fenêtre neuve pour l'extension et y rapatrie ses onglets.
 * Utile quand la fenêtre dédiée a été fermée, ou que les onglets ont fini
 * éparpillés dans les fenêtres de l'utilisateur.
 */
export async function rebuildWindow(settings) {
  const created = await chrome.windows.create({ state: "minimized", focused: false });
  const blank = created.tabs?.[0]?.id ?? null;
  await store.setState({ windowId: created.id });

  const { placed } = await regroupTabs({ ...settings, dedicatedWindow: true });

  // L'onglet vide créé avec la fenêtre n'est fermé que si un autre l'a remplacé :
  // fermer le dernier onglet fermerait la fenêtre qu'on vient de faire.
  if (blank && placed > 0) await closeTab(blank);

  return { windowId: created.id, placed };
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

/** Réapplique la sourdine à tous les onglets gérés, après un changement de réglage. */
export async function refreshTabMute(settings) {
  const state = await store.getState();
  for (const tabId of [state.pointsTabId, state.dropsTabId, state.inventoryTabId]) {
    if (tabId && (await tabExists(tabId))) await applyTabMute(tabId, settings);
  }
}

export { tabExists, closeTab, openBackgroundTab };
