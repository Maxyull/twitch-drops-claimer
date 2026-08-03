// Service worker : alarmes, aiguillage des messages, voyants, badge.
// Aucun état en mémoire longue durée : Chrome peut le tuer à tout moment,
// tout ce qui compte est dans chrome.storage (cf. docs/AUDIT-SECU.md).

import { evaluateBeat, summarize, STATUS } from "../lib/status.js";
import { campaignProgress, rankCampaigns, claimableDrops } from "../lib/campaigns.js";
import { countOpen, linkedOverrides, redeemAction, addAction, setDone } from "../lib/actions.js";
import { MSG, CLAIM_KIND, ROLE } from "../lib/messaging.js";
import { validateMessage } from "../lib/message-guard.js";
import * as store from "../lib/storage.js";
import * as farm from "./farm.js";
import * as notify from "./notify.js";

const ALARM_TICK = "tdc-tick";
const ALARM_DISCOVER = "tdc-discover";
const ALARM_CLAIM = "tdc-claim";

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
}

async function boot() {
  await store.migrate();
  await installAlarms();
  await updateBadge();
}

chrome.runtime.onInstalled.addListener(() => void boot());
chrome.runtime.onStartup.addListener(() => void boot());

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_TICK) void tick();
  if (alarm.name === ALARM_DISCOVER) void discover();
  if (alarm.name === ALARM_CLAIM) void claimSweep();
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
    if (!status.drops.green) await farm.ensureDropsTab(settings);
    await store.setLastError(null);
  } catch (err) {
    await store.setLastError(err.message);
  }
  await updateBadge();
}

async function discover() {
  const settings = await store.getSettings();
  if (!settings.enabled) return;

  try {
    const campaigns = await farm.refreshCampaigns();
    const { added } = await farm.syncActions(campaigns);

    if (settings.notifyActions) {
      for (const action of added) await notify.notifyActionRequired(action);
    }

    await farm.ensureDropsTab(settings);
    await store.setLastError(null);
  } catch (err) {
    await store.setLastError(err.message);
    if (err.kind === "auth" && settings.notifyActions) notify.notifyProblem(err.message);
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
    if (!active) return { code: STATUS.DISABLED, green: false, label: "désactivé", channel: null };
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
      : chrome.i18n.getMessage("badge_problem", [status.global.label]),
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

  await store.bumpStat(kind === CLAIM_KIND.POINTS ? "points" : "drops", name);

  if (kind === CLAIM_KIND.POINTS) {
    if (settings.notifyDrops) notify.notifyPointsClaimed(channel);
    await updateBadge();
    return { ok: true };
  }

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
  return { ok: true };
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

  const campaigns = rankCampaigns(cached.campaigns, {
    strategy: settings.priority,
    blacklist: settings.campaignBlacklist,
    linkedOverrides: linkedOverrides(actions),
    onlyLinkedCampaigns: settings.onlyLinkedCampaigns,
  }).map((c) => ({
    id: c.id,
    name: c.name,
    game: c.gameName,
    endAt: c.endAt,
    accountLinkURL: c.accountLinkURL,
    detailsURL: c.detailsURL,
    progress: campaignProgress(c),
    claimable: claimableDrops(c).length,
    current: c.id === state.dropsCampaignId,
  }));

  return {
    settings,
    stats,
    actions,
    status,
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
    before.discoverIntervalMin !== settings.discoverIntervalMin
  ) {
    await installAlarms();
  }
  if (!settings.enabled) await farm.closeAllTabs();
  else await tick();

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

  HANDLERS[check.type](check.payload, sender.tab?.id ?? null)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: err.message }));
  return true; // réponse asynchrone
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void store.forgetTab(tabId).then(updateBadge);
});

notify.registerNotificationHandlers(async (actionId) => {
  await store.setActions(setDone(await store.getActions(), actionId, true));
  await updateBadge();
});

// Pas de `tick()` au chargement du module : le service worker est réveillé à
// chaque message, ça relancerait la mécanique en boucle. C'est l'alarme qui pilote.
void updateBadge();
