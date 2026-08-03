// Service worker : alarmes, aiguillage des messages, voyants, badge.
// Aucun état en mémoire longue durée : Chrome peut le tuer à tout moment,
// tout ce qui compte est dans chrome.storage (cf. docs/AUDIT-SECU.md).

import { evaluateBeat, summarize, STATUS } from "../lib/status.js";
import { evaluateCounted } from "../lib/counted.js";
import { campaignProgress, rankCampaigns, claimableDrops, isActive } from "../lib/campaigns.js";
import { countOpen, linkedOverrides, redeemAction, addAction, setDone } from "../lib/actions.js";
import { MSG, CLAIM_KIND, ROLE } from "../lib/messaging.js";
import { validateMessage } from "../lib/message-guard.js";
import * as store from "../lib/storage.js";
import * as farm from "./farm.js";
import * as notify from "./notify.js";
import { registerHeaderCapture } from "./header-capture.js";
import { registerWatchCounter, forgetCountedTab, flushWatchCounter } from "./watch-counter.js";

const ALARM_TICK = "tdc-tick";
const ALARM_DISCOVER = "tdc-discover";
const ALARM_CLAIM = "tdc-claim";
const ALARM_ROTATE = "tdc-rotate";

const COLOR_GREEN = "#00b37e";
const COLOR_RED = "#e02f2f";
const COLOR_ORANGE = "#d98324";

// --- alarmes --------------------------------------------------------------

async function installAlarms() {
  const settings = await store.getSettings();
  await chrome.alarms.clearAll();
  chrome.alarms.create(ALARM_TICK, { periodInMinutes: 1 });
  chrome.alarms.create(ALARM_DISCOVER, {
    periodInMinutes: settings.discoverIntervalMin,
    delayInMinutes: 0.2,
  });
  chrome.alarms.create(ALARM_CLAIM, {
    periodInMinutes: settings.claimIntervalMin,
    delayInMinutes: 0.5,
  });
  if (settings.rotateIntervalMin > 0) {
    chrome.alarms.create(ALARM_ROTATE, {
      periodInMinutes: settings.rotateIntervalMin,
      delayInMinutes: settings.rotateIntervalMin,
    });
  }
}

// La migration tourne au démarrage du service worker, pas seulement sur
// `onInstalled` / `onStartup` : ces évènements peuvent être manqués, et rien ne
// doit lire les réglages avant qu'elle soit passée. Elle est idempotente, un
// simple test de version dans la plupart des cas.
const migrated = store.migrate().catch((err) => {
  console.error("[TDC] migration impossible :", err);
});

async function boot() {
  await migrated;
  await installAlarms();
  await updateBadge();
}

chrome.runtime.onInstalled.addListener(() => void boot());
chrome.runtime.onStartup.addListener(() => void boot());

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_TICK) void tick();
  if (alarm.name === ALARM_DISCOVER) void discover();
  if (alarm.name === ALARM_CLAIM) void claimSweep();
  if (alarm.name === ALARM_ROTATE) void rotate();
});

// --- boucles --------------------------------------------------------------

async function tick() {
  const settings = await store.getSettings();
  if (!settings.enabled) {
    await updateBadge();
    return;
  }

  // On n'interroge Twitch que si un voyant est au rouge : tant que ça tourne,
  // il n'y a rien à réparer et rien à demander à l'API.
  const status = await computeStatus();

  try {
    if (!status.points.green) await farm.ensurePointsTab(settings);
    if (!status.drops.green) {
      // Une chaîne passée hors ligne ne reviendra pas : on force le changement
      // plutôt que d'attendre que l'API confirme ce que le lecteur constate déjà.
      await farm.ensureDropsTab(settings, { force: status.drops.code === STATUS.OFFLINE });
    }
    await farm.closeInventoryIfRedundant();
    await farm.refreshPointsBalance();
    await farm.refreshWatchProof();
    if (settings.dedicatedWindow) await farm.regroupTabs(settings);
    if (settings.wakeStuckTabs) await wakeStuckTabs(status);
    await store.setLastError(null);
  } catch (err) {
    await store.setLastError(err.message);
  }
  await updateBadge();
}

/**
 * Passage périodique dans la fenêtre de l'extension : on avance d'un onglet à
 * chaque tour et on l'y laisse actif, plutôt que de tous les parcourir pour
 * n'en laisser qu'un devant. Chacun a ainsi son temps au premier plan, ce qui
 * suffit à relancer un lecteur que le navigateur avait mis de côté.
 * Seul un onglet qui n'est pas au vert est rechargé : recharger un onglet qui
 * marche couperait le visionnage pour rien.
 */
async function rotate() {
  const settings = await store.getSettings();
  if (!settings.enabled || settings.rotateIntervalMin <= 0) return;

  const status = await computeStatus();
  const state = await store.getState();

  const tabs = [
    [state.pointsTabId, status.points],
    [state.dropsTabId, status.drops],
  ].filter(([tabId]) => tabId);
  if (!tabs.length) return;

  const index = ((state.rotationIndex ?? -1) + 1) % tabs.length;
  const [tabId, tabStatus] = tabs[index];

  await farm.wakeTab(tabId);
  if (!tabStatus.green) await farm.reloadTab(tabId);

  await store.setState({ rotationIndex: index });
  await updateBadge();
}

const WAKE_COOLDOWN_MS = 3 * 60_000;

/**
 * Un lecteur que le navigateur a refusé de démarrer ne repartira pas tout seul :
 * activer son onglet lui donne le contexte qui manque. On espace les tentatives,
 * il ne s'agit pas de faire clignoter le navigateur.
 */
async function wakeStuckTabs(status) {
  const state = await store.getState();
  const now = Date.now();
  const wokeAt = { ...state.wokeAt };
  let changed = false;

  const stuck = [
    [state.pointsTabId, status.points],
    [state.dropsTabId, status.drops],
  ];

  for (const [tabId, s] of stuck) {
    if (!tabId || s.code !== STATUS.BLOCKED) continue;
    if (now - (wokeAt[tabId] ?? 0) < WAKE_COOLDOWN_MS) continue;
    if (await farm.wakeTab(tabId)) {
      wokeAt[tabId] = now;
      changed = true;
    }
  }

  if (changed) await store.setState({ wokeAt });
}

async function discover() {
  const settings = await store.getSettings();
  if (!settings.enabled) return;

  try {
    const campaigns = await farm.refreshCampaigns();
    await farm.syncClaimedDrops(campaigns);
    const { added } = await farm.syncActions(campaigns);

    if (settings.notifyActions) {
      for (const action of added) await notify.notifyActionRequired(action);
    }

    await farm.ensureDropsTab(settings);
    await store.setLastError(null);
  } catch (err) {
    await store.setLastError(err.message);

    // Sans onglet Twitch ouvert, aucun jeton d'intégrité à reprendre, donc aucune
    // requête possible. On en ouvre un : il servira aussi au prochain passage de
    // réclamation, et la capture se fera toute seule au chargement de la page.
    if (err.kind === "integrity") await farm.ensureHarvestTab();
    else if (err.kind === "auth" && settings.notifyActions) notify.notifyProblem(err.message);
  }
  await updateBadge();
}

async function claimSweep() {
  const settings = await store.getSettings();
  if (!settings.enabled) return;
  try {
    await farm.runClaimSweep(settings);
    await store.setLastError(null);
  } catch (err) {
    await store.setLastError(err.message);
  }
}

// --- voyants --------------------------------------------------------------

async function computeStatus() {
  const settings = await store.getSettings();
  const state = await store.getState();
  const now = Date.now();

  async function one(tabId, expectedChannel, active) {
    if (!active) return { code: STATUS.DISABLED, green: false, channel: null };
    return evaluateBeat(state.beats[tabId] ?? null, state.prevBeats[tabId] ?? null, {
      now,
      expectedChannel,
      tabExists: await farm.tabExists(tabId),
      enabled: settings.enabled,
    });
  }

  const points = await one(
    state.pointsTabId,
    state.pointsChannel,
    settings.enabled && settings.watchFavorite && settings.favoriteChannels.length > 0,
  );
  const drops = await one(
    state.dropsTabId,
    state.dropsChannel,
    settings.enabled && settings.farmDrops && settings.autoDiscover,
  );

  return {
    points: { ...points, channel: points.channel ?? state.pointsChannel },
    drops: { ...drops, channel: drops.channel ?? state.dropsChannel },
    global: summarize([points, drops]),
  };
}

/**
 * Une ligne par onglet que l'extension fait tourner en arrière-plan : quelle
 * chaîne, pour quoi faire, et surtout si Twitch la comptabilise réellement.
 */
async function computeWatchers(status) {
  await flushWatchCounter();

  const state = await store.getState();
  const { campaigns } = await store.getCampaigns();
  const now = Date.now();

  const rows = [
    { role: ROLE.POINTS, tabId: state.pointsTabId, channel: state.pointsChannel, status: status.points },
    {
      role: ROLE.DROPS,
      tabId: state.dropsTabId,
      channel: state.dropsChannel,
      status: status.drops,
      campaignId: state.dropsCampaignId,
      since: state.dropsSince,
    },
  ];

  return rows
    .filter((row) => row.tabId && row.channel && row.status.code !== STATUS.DISABLED)
    .map((row) => ({
      role: row.role,
      tabId: row.tabId,
      channel: row.channel,
      since: row.since ?? null,
      campaignName: campaigns.find((c) => c.id === row.campaignId)?.name ?? null,
      status: { code: row.status.code, green: row.status.green },
      points:
        row.role === ROLE.POINTS && state.pointsBalance?.channel === row.channel
          ? state.pointsBalance.balance
          : null,
      counted: evaluateCounted(
        {
          ...state.counted[row.tabId],
          // La progression est attribuée au rôle, pas à l'onglet : c'est la
          // campagne suivie ou le solde de la chaîne favorite qui avance.
          progressAt: row.role === ROLE.POINTS ? state.proof?.pointsAt : state.proof?.dropsAt,
        },
        { now, since: row.since, playing: row.status.green },
      ),
    }));
}

async function updateBadge() {
  const open = countOpen(await store.getActions());

  if (open > 0) {
    await chrome.action.setBadgeText({ text: String(open) });
    await chrome.action.setBadgeBackgroundColor({ color: COLOR_ORANGE });
    await chrome.action.setTitle({ title: chrome.i18n.getMessage("badge_actions", [String(open)]) });
    return;
  }

  const settings = await store.getSettings();
  if (!settings.enabled) {
    await chrome.action.setBadgeText({ text: "" });
    await chrome.action.setTitle({ title: chrome.i18n.getMessage("badge_disabled") });
    return;
  }

  const status = await computeStatus();
  await chrome.action.setBadgeText({ text: "●" });
  await chrome.action.setBadgeBackgroundColor({
    color: status.global.green ? COLOR_GREEN : COLOR_RED,
  });
  await chrome.action.setTitle({
    title: status.global.green
      ? chrome.i18n.getMessage("badge_watching")
      : chrome.i18n.getMessage("badge_problem", [
          chrome.i18n.getMessage(`status_${status.global.code}`),
        ]),
  });
}

// --- rôle d'un onglet -----------------------------------------------------

async function roleFor(tabId) {
  const state = await store.getState();
  if (tabId === state.pointsTabId) return ROLE.POINTS;
  if (tabId === state.dropsTabId) return ROLE.DROPS;
  if (tabId === state.inventoryTabId) return ROLE.INVENTORY;
  return ROLE.PASSIVE;
}

// --- traitement des messages ---------------------------------------------
// Un handler par type, jamais de dispatch dynamique sur une clé du message.

async function onHello(payload, tabId) {
  const settings = await store.getSettings();
  const role = await roleFor(tabId);
  return {
    role,
    enabled: settings.enabled,
    claimPoints: settings.claimPoints,
    farmDrops: settings.farmDrops,
    // On ne force qualité et volume que sur NOS onglets : celui que
    // l'utilisateur regarde vraiment ne doit pas tomber en 160p.
    forcePlayer: role === ROLE.POINTS || role === ROLE.DROPS,
    quality: settings.quality,
    volumePercent: settings.volumePercent,
    muteTabs: settings.muteTabs,
  };
}

async function onBeat(payload, tabId) {
  if (tabId == null) return { ok: false };
  await store.recordBeat(tabId, { ...payload, at: Date.now() });
  return { ok: true };
}

async function onClaimed(payload) {
  const settings = await store.getSettings();
  const { kind, label, channel, dropName, campaignId } = payload;
  const name = dropName || label;

  if (kind === CLAIM_KIND.POINTS) {
    await store.bumpStat("points", name);
    if (settings.notifyDrops) notify.notifyPointsClaimed(channel);
    await updateBadge();
    return { ok: true };
  }

  // Le compteur de drops ne suit PAS nos clics : un clic peut échouer, et Twitch
  // peut créditer un palier sans nous. Il est recalculé depuis l'inventaire, que
  // cette recherche va justement rafraîchir.
  await store.touchLastClaim(name);
  void discover();

  const { campaigns } = await store.getCampaigns();
  const campaign =
    campaigns.find((c) => c.id === campaignId) ||
    (name ? campaigns.find((c) => c.drops.some((d) => d.name === name)) : null);

  if (settings.notifyDrops) {
    notify.notifyDropClaimed({
      dropName: name,
      campaignName: campaign?.name,
      game: campaign?.gameName,
    });
  }

  // Récompense qui s'active chez l'éditeur : on l'ajoute à la liste à cocher.
  const drop = campaign?.drops.find((d) => d.name === name);
  const action = redeemAction(campaign, drop);
  if (action) {
    await store.setActions(addAction(await store.getActions(), action));
    if (settings.notifyActions) notify.notifyActionRequired(action);
  }

  await updateBadge();
  return { ok: true };
}

async function onInventoryDone() {
  void discover(); // l'inventaire a bougé : on rafraîchit la progression réelle
  void farm.closeInventoryIfRedundant();
  return { ok: true };
}

/** Poids de tri d'une campagne dans la liste du popup. */
function sortWeight(c) {
  if (c.rank !== null) return c.rank;
  if (!c.selected) return 20_000;
  return 10_000; // gardée mais hors rotation : terminée, ou compte non lié
}

async function onGetState() {
  const [settings, stats, actions, status, state, lastError, cached] = await Promise.all([
    store.getSettings(),
    store.getStats(),
    store.getActions(),
    computeStatus(),
    store.getState(),
    store.getLastError(),
    store.getCampaigns(),
  ]);

  // Le popup montre TOUTES les campagnes actives, pas seulement celles qu'on
  // farme : on ne peut pas choisir ce qu'on ne voit pas. `rank` dit la place
  // dans la rotation, `selected` si l'utilisateur la veut.
  const blacklist = new Set(settings.campaignBlacklist);
  const rank = new Map(
    rankCampaigns(cached.campaigns, {
      strategy: settings.priority,
      blacklist: settings.campaignBlacklist,
      linkedOverrides: linkedOverrides(actions),
      onlyLinkedCampaigns: settings.onlyLinkedCampaigns,
    }).map((c, i) => [c.id, i]),
  );

  const campaigns = cached.campaigns
    .filter((c) => isActive(c))
    .map((c) => ({
      id: c.id,
      name: c.name,
      game: c.gameName,
      endAt: c.endAt,
      accountLinkURL: c.accountLinkURL,
      detailsURL: c.detailsURL,
      progress: campaignProgress(c),
      claimable: claimableDrops(c).length,
      current: c.id === state.dropsCampaignId,
      selected: !blacklist.has(c.id),
      rank: rank.has(c.id) ? rank.get(c.id) : null,
    }))
    // Dans l'ordre de la rotation, puis les terminées, puis les écartées.
    .sort((a, b) => sortWeight(a) - sortWeight(b));

  return {
    settings,
    stats,
    actions,
    status,
    watchers: await computeWatchers(status),
    lastError,
    campaigns,
    campaignsAt: cached.campaignsAt,
    current: {
      pointsChannel: state.pointsChannel,
      dropsChannel: state.dropsChannel,
      dropsCampaignId: state.dropsCampaignId,
      dropsSince: state.dropsSince,
    },
  };
}

async function onSetSettings(payload) {
  const before = await store.getSettings();
  const settings = await store.setSettings(payload);

  if (
    before.claimIntervalMin !== settings.claimIntervalMin ||
    before.discoverIntervalMin !== settings.discoverIntervalMin ||
    before.rotateIntervalMin !== settings.rotateIntervalMin
  ) {
    await installAlarms();
  }
  if (before.muteTabs !== settings.muteTabs) await farm.refreshTabMute(settings);

  if (!settings.enabled) {
    await farm.closeAllTabs();
  } else {
    // Surtout pas d'`await` : `tick()` interroge Twitch et ouvre des onglets.
    // La page d'options n'a pas à attendre tout ça pour savoir que c'est enregistré.
    void tick();
  }

  await updateBadge();
  return { ok: true, settings };
}

async function onSetActionDone(payload) {
  const list = setDone(await store.getActions(), payload.id, payload.done);
  await store.setActions(list);
  await updateBadge();
  return { ok: true, actions: list };
}

async function onRefreshNow() {
  await discover();
  await claimSweep();
  return { ok: true };
}

async function onSwitchNow() {
  await farm.ensureDropsTab(await store.getSettings(), { force: true });
  await updateBadge();
  return { ok: true };
}

async function onBlacklistCampaign(payload) {
  const settings = await store.getSettings();
  const list = new Set(settings.campaignBlacklist);
  if (payload.remove) list.delete(payload.id);
  else list.add(payload.id);

  const updated = await store.setSettings({ campaignBlacklist: [...list] });
  await farm.ensureDropsTab(updated, { force: true });
  return { ok: true };
}

const HANDLERS = {
  [MSG.HELLO]: onHello,
  [MSG.BEAT]: onBeat,
  [MSG.CLAIMED]: onClaimed,
  [MSG.INVENTORY_DONE]: onInventoryDone,
  [MSG.GET_STATE]: onGetState,
  [MSG.SET_SETTINGS]: onSetSettings,
  [MSG.SET_ACTION_DONE]: onSetActionDone,
  [MSG.REFRESH_NOW]: onRefreshNow,
  [MSG.SWITCH_NOW]: onSwitchNow,
  [MSG.BLACKLIST_CAMPAIGN]: onBlacklistCampaign,
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const check = validateMessage(msg, sender, chrome.runtime.id);
  if (!check.ok || !Object.hasOwn(HANDLERS, check.type)) {
    console.warn("[TDC] message rejeté :", check.error ?? check.type);
    sendResponse({ ok: false, error: check.error ?? "type inconnu" });
    return false;
  }

  // On attend la migration : aucun réglage ne doit être lu ni écrit avant elle.
  migrated
    .then(() => HANDLERS[check.type](check.payload, sender.tab?.id ?? null))
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: err.message }));
  return true; // réponse asynchrone
});

chrome.tabs.onRemoved.addListener((tabId) => {
  forgetCountedTab(tabId);
  void store.forgetTab(tabId).then(updateBadge);
});

notify.registerNotificationHandlers(async (actionId) => {
  await store.setActions(setDone(await store.getActions(), actionId, true));
  await updateBadge();
});

// À enregistrer au chargement du module, de façon synchrone : le service worker
// est réveillé et tué en permanence, un écouteur posé plus tard raterait des requêtes.
registerHeaderCapture();
registerWatchCounter();

// Pas de `tick()` au chargement du module : le service worker est réveillé à
// chaque message, ça relancerait la mécanique en boucle. C'est l'alarme qui pilote.
void updateBadge();
