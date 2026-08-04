// Service worker: alarms, message routing, indicators, badge.
// No long-lived in-memory state: Chrome can kill it at any moment, so everything
// that matters lives in chrome.storage (see docs/SECURITY-AUDIT.md).

import { evaluateBeat, summarize, STATUS } from "../lib/status.js";
import { evaluateCounted } from "../lib/counted.js";
import { evaluateAlert, minutesOf } from "../lib/alert.js";
import { campaignProgress, rankCampaigns, claimableDrops, isActive } from "../lib/campaigns.js";
import { countOpen, linkedOverrides, redeemAction, addAction, setDone } from "../lib/actions.js";
import { MSG, CLAIM_KIND, ROLE, CAMPAIGN_PRIORITY } from "../lib/messaging.js";
import { validateMessage } from "../lib/message-guard.js";
import * as store from "../lib/storage.js";
import * as farm from "./farm.js";
import * as notify from "./notify.js";
import * as pubsub from "./pubsub.js";
import { t, initI18n } from "../lib/i18n.js";
import { EVENT } from "../lib/pubsub-messages.js";
import { registerHeaderCapture } from "./header-capture.js";
import { registerWatchCounter, forgetCountedTab, flushWatchCounter } from "./watch-counter.js";

const ALARM_TICK = "tdc-tick";
const ALARM_DISCOVER = "tdc-discover";
const ALARM_CLAIM = "tdc-claim";
const ALARM_ROTATE = "tdc-rotate";

const COLOR_GREEN = "#00b37e";
const COLOR_RED = "#e02f2f";
const COLOR_ORANGE = "#d98324";

// --- alarms -----------------------------------------------------------------

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

// The migration runs when the service worker starts, not only on `onInstalled` /
// `onStartup`: those events can be missed, and nothing must read the settings
// before it has gone through. It is idempotent, a plain version check in most
// cases.
const migrated = store.migrate().catch((err) => {
  console.error("[TDC] migration impossible :", err);
});

// The translation catalogue loads when the module starts, for the same reason as
// the migration: the service worker can wake on an alarm without ever seeing
// `onInstalled` or `onStartup`. Without this, the badge title and the
// notifications would come out as raw keys.
let i18nReady = migrated
  .then(() => store.getSettings())
  .then((settings) => initI18n(settings.language))
  .catch((err) => console.warn("[TDC] traductions indisponibles :", err));

async function boot() {
  await migrated;
  await i18nReady;
  // Before any alarm, therefore before anything opens a tab: the previous session
  // may have left a window behind, and the last thing we want is to open a second
  // one next to it.
  await farm.adoptExistingWindow();
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

// --- loops ------------------------------------------------------------------

async function tick() {
  await i18nReady;
  const settings = await store.getSettings();
  if (!settings.enabled) {
    await updateBadge();
    return;
  }

  // Twitch is only queried when an indicator is red: while it is running there is
  // nothing to repair and nothing to ask the API for.
  const status = await computeStatus();

  try {
    if (!status.points.green) await farm.ensurePointsTab(settings);
    if (status.drops.some((s) => !s.green)) {
      // A channel that has gone offline will not come back: force the switch
      // rather than wait for the API to confirm what the player already sees.
      const horsLigne = status.drops.some((s) => s.code === STATUS.OFFLINE);
      await farm.ensureDropsTabs(settings, { force: horsLigne });
    }
    // The cleanup comes AFTER: the ensure* calls first reclaim the already open
    // tabs they need, so only genuine duplicates get closed. The other way round,
    // we were closing what we were about to reopen a moment later.
    await farm.closeOrphanTabs();
    await farm.closeInventoryIfRedundant();
    const points = await farm.refreshPoints(settings);
    if (points?.claimed && settings.notifyDrops) notify.notifyPointsClaimed(points.channel);
    await farm.refreshWatchProof();
    await farm.refreshLiveProgress();
    if (settings.dedicatedWindow) await farm.regroupTabs(settings);
    if (settings.wakeStuckTabs) await wakeStuckTabs(status);
    await checkAlert(settings, status);
    await keepRealtime(settings);
    await store.setLastError(null);
  } catch (err) {
    await store.setLastError(err.message);
  }
  await updateBadge();
}

// --- real time ----------------------------------------------------------------

/**
 * The real-time connection is reopened here, on every pass, and nowhere else.
 * Chrome can recycle the service worker at any moment: the socket goes with it,
 * and it is the one-minute loop that brings it back. Nothing depends on it, it
 * only makes things arrive sooner.
 */
async function keepRealtime(settings) {
  if (!settings.realtime) {
    pubsub.disconnect();
    return;
  }
  await pubsub.ensureConnected({
    userId: await farm.getUserId(),
    // Raids only announce themselves by channel id, and the list of watched
    // channels changes: the subscriptions follow it.
    channelIds: Object.values(await farm.refreshChannelIds()),
    onEvent: (evt) => onRealtimeEvent(evt, settings),
  });
}

async function onRealtimeEvent(evt, settings) {
  switch (evt.kind) {
    case EVENT.DROP_PROGRESS:
      await farm.applyRealtimeDrop(evt);
      break;

    case EVENT.DROP_CLAIM:
      // Twitch announces a tier is ready. The existing sweep knows how to take it
      // and already deduplicates: we call it sooner, we do not duplicate it.
      await farm.runClaimSweep(settings);
      break;

    case EVENT.POINTS_AVAILABLE: {
      // Same reasoning: `refreshPoints` claims through the API and deduplicates.
      const points = await farm.refreshPoints(settings, { force: true });
      if (points?.claimed && settings.notifyDrops) notify.notifyPointsClaimed(points.channel);
      break;
    }

    case EVENT.POINTS_EARNED:
      await farm.noteRealtimePoints();
      break;

    case EVENT.RAID: {
      const res = await farm.handleRaid(evt, settings);
      if (res.joined && settings.notifyDrops) notify.notifyRaidJoined(evt.targetLogin);
      break;
    }

    default:
      break;
  }
  await updateBadge();
}

/**
 * Periodic pass through the extension's window: move on by one tab each round and
 * leave that one active, rather than walking through them all only to leave one
 * in front. Each tab therefore gets its turn in the foreground, which is enough
 * to restart a player the browser had set aside.
 * Only a tab that is not green gets reloaded: reloading a working tab would cut
 * the viewing for nothing.
 */
async function rotate() {
  const settings = await store.getSettings();
  if (!settings.enabled || settings.rotateIntervalMin <= 0) return;

  const status = await computeStatus();
  const state = await store.getState();

  const tabs = [
    [state.pointsTabId, status.points],
    ...(state.dropTabs ?? []).map((entry, i) => [entry.tabId, status.drops[i]]),
  ].filter(([tabId, s]) => tabId && s);
  if (!tabs.length) return;

  const index = ((state.rotationIndex ?? -1) + 1) % tabs.length;
  const [tabId, tabStatus] = tabs[index];

  await farm.wakeTab(tabId);
  if (!tabStatus.green) await farm.reloadTab(tabId);

  await store.setState({ rotationIndex: index });
  await updateBadge();
}

/**
 * Warns when farming has not been running for a while.
 *
 * Without it, the whole diagnosis only serves whoever thinks to open the popup:
 * you start farming in the evening and find out in the morning that it stopped at
 * 10 pm.
 */
async function checkAlert(settings, status) {
  if (!settings.notifyProblems) return;

  const state = await store.getState();
  const res = evaluateAlert(
    {
      green: status.global.green,
      code: status.global.code,
      brokenSince: state.brokenSince,
      alertedAt: state.alertedAt,
    },
    { now: Date.now(), afterMs: settings.alertAfterMin * 60_000, idleCode: STATUS.DISABLED },
  );

  if (res.brokenSince !== state.brokenSince || res.alertedAt !== state.alertedAt) {
    await store.setState({ brokenSince: res.brokenSince, alertedAt: res.alertedAt });
  }

  if (res.notify) {
    notify.notifyStalled(
      t(`status_${status.global.code}`),
      minutesOf(res.brokenFor),
    );
  }
}

const WAKE_COOLDOWN_MS = 3 * 60_000;

/**
 * A player the browser refused to start will not restart on its own: activating
 * its tab gives it the missing context. The attempts are spaced out; the point is
 * not to make the browser flicker.
 */
async function wakeStuckTabs(status) {
  const state = await store.getState();
  const now = Date.now();
  const wokeAt = { ...state.wokeAt };
  let changed = false;

  const stuck = [
    [state.pointsTabId, status.points],
    ...(state.dropTabs ?? []).map((entry, i) => [entry.tabId, status.drops[i]]),
  ].filter(([tabId, s]) => tabId && s);

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

  let campaigns = null;
  try {
    campaigns = await farm.refreshCampaigns();
    await store.setLastError(null);
  } catch (err) {
    await store.setLastError(err.message);

    // With no Twitch tab open there is no integrity token to pick up, therefore no
    // request is possible. Open one: it will serve the next claim pass too, and
    // the capture happens by itself when the page loads.
    if (err.kind === "integrity") await farm.ensureHarvestTab();
    else if (err.kind === "auth" && settings.notifyActions) notify.notifyProblem(err.message);
  }

  // Counting drops does not depend on the full discovery succeeding: the
  // inventory alone carries that information, and one request is enough. Tying it
  // to the rest lost all counting on the slightest API hiccup.
  try {
    await farm.syncClaimedDrops(campaigns ?? (await farm.inventoryCampaigns()));
  } catch {
    /* inventory unavailable: we will try again on the next pass */
  }

  if (campaigns) {
    const { added } = await farm.syncActions(campaigns);
    if (settings.notifyActions) {
      for (const action of added) await notify.notifyActionRequired(action);
    }
    try {
      await farm.ensureDropsTabs(settings);
    } catch (err) {
      await store.setLastError(err.message);
    }
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

// --- indicators ---------------------------------------------------------------

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
  const actif = settings.enabled && settings.farmDrops && settings.autoDiscover;
  const drops = [];
  for (const entry of state.dropTabs ?? []) {
    const s = await one(entry.tabId, entry.channel, actif);
    drops.push({ ...s, channel: s.channel ?? entry.channel });
  }

  return {
    points: { ...points, channel: points.channel ?? state.pointsChannel },
    drops,
    global: summarize([points, ...drops]),
  };
}

/**
 * One row per tab the extension runs in the background: which channel, what for,
 * and above all whether Twitch is really counting it.
 */
async function computeWatchers(status) {
  await flushWatchCounter();

  const state = await store.getState();
  const { campaigns } = await store.getCampaigns();
  const now = Date.now();

  const rows = [
    {
      role: ROLE.POINTS,
      tabId: state.pointsTabId,
      channel: state.pointsChannel,
      status: status.points,
    },
    ...(state.dropTabs ?? []).map((entry, i) => ({
      role: ROLE.DROPS,
      tabId: entry.tabId,
      channel: entry.channel,
      status: status.drops[i],
      campaignId: entry.campaignId,
      since: entry.since,
    })),
  ].filter((row) => row.status);

  return rows
    .filter((row) => row.tabId && row.channel && row.status.code !== STATUS.DISABLED)
    .map((row) => ({
      role: row.role,
      tabId: row.tabId,
      channel: row.channel,
      since: row.since ?? null,
      campaignName: campaigns.find((c) => c.id === row.campaignId)?.name ?? null,
      status: { code: row.status.code, green: row.status.green },
      // The balance of EVERY watched channel, not only the favourite: chests are
      // now claimed everywhere, and the row has to be able to show it.
      points: state.pointsByChannel?.[row.channel]?.balance ?? null,
      counted: evaluateCounted(
        {
          ...state.counted[row.tabId],
          // Progress is attributed to the role, not to the tab: what advances is
          // the campaign being followed, or the favourite channel's balance.
          progressAt:
            row.role === ROLE.POINTS
              ? state.proof?.pointsAt
              : state.proof?.dropsAt?.[row.campaignId],
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
    await chrome.action.setTitle({ title: t("badge_actions", [String(open)]) });
    return;
  }

  const settings = await store.getSettings();
  if (!settings.enabled) {
    await chrome.action.setBadgeText({ text: "" });
    await chrome.action.setTitle({ title: t("badge_disabled") });
    return;
  }

  const status = await computeStatus();
  await chrome.action.setBadgeText({ text: "●" });
  await chrome.action.setBadgeBackgroundColor({
    color: status.global.green ? COLOR_GREEN : COLOR_RED,
  });
  await chrome.action.setTitle({
    title: status.global.green
      ? t("badge_watching")
      : t("badge_problem", [
          t(`status_${status.global.code}`),
        ]),
  });
}

// --- a tab's role -------------------------------------------------------------

async function roleFor(tabId) {
  const state = await store.getState();
  if (tabId === state.pointsTabId) return ROLE.POINTS;
  if ((state.dropTabs ?? []).some((entry) => entry.tabId === tabId)) return ROLE.DROPS;
  if (tabId === state.inventoryTabId) return ROLE.INVENTORY;
  return ROLE.PASSIVE;
}

// --- message handling ---------------------------------------------------------
// One handler per type, never a dynamic dispatch on a key of the message.

async function onHello(payload, tabId) {
  const settings = await store.getSettings();
  const role = await roleFor(tabId);
  return {
    role,
    enabled: settings.enabled,
    claimPoints: settings.claimPoints,
    farmDrops: settings.farmDrops,
    // Quality and volume are forced on OUR tabs only: the one the user is really
    // watching must not drop to 160p.
    forcePlayer: role === ROLE.POINTS || role === ROLE.DROPS,
    // The tab must keep its marker: that is what will allow finding it again
    // after an extension reload.
    owned: role !== ROLE.PASSIVE,
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
    // Same guard as the API path: a chest is counted once, whichever of the two
    // took it.
    const compte = await farm.recordPointsClaim(channel);
    if (compte && settings.notifyDrops) notify.notifyPointsClaimed(channel);
    await updateBadge();
    return { ok: true, counted: compte };
  }

  // The drop counter does NOT follow our clicks: a click can fail, and Twitch can
  // credit a tier without us. It is recomputed from the inventory, which this
  // discovery pass is about to refresh.
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

  // A reward that activates on the publisher's site: add it to the checklist.
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
  void discover(); // the inventory moved: refresh the real progress
  void farm.closeInventoryIfRedundant();
  return { ok: true };
}

/** Sort weight of a campaign in the popup's list. */
function sortWeight(c) {
  if (c.rank !== null) return c.rank;
  if (!c.selected) return 20_000;
  return 10_000; // kept but out of rotation: finished, or account not linked
}

async function onGetState() {
  const [settings, stats, actions, status, state, lastError, cached, history] = await Promise.all([
    store.getSettings(),
    store.getStats(),
    store.getActions(),
    computeStatus(),
    store.getState(),
    store.getLastError(),
    store.getCampaigns(),
    store.getHistory(),
  ]);

  // The popup shows ALL active campaigns, not only the ones being farmed: you
  // cannot choose what you cannot see. `rank` gives the place in the rotation,
  // `selected` whether the user wants it.
  const blacklist = new Set(settings.campaignBlacklist);
  const focusSet = new Set(settings.focusCampaigns);
  const rank = new Map(
    rankCampaigns(cached.campaigns, {
      strategy: settings.priority,
      blacklist: settings.campaignBlacklist,
      focus: settings.focusCampaigns,
      randomAfterFocus: settings.randomAfterFocus,
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
      current: (state.dropTabs ?? []).some((entry) => entry.campaignId === c.id),
      selected: !blacklist.has(c.id),
      focus: focusSet.has(c.id),
      rank: rank.has(c.id) ? rank.get(c.id) : null,
    }))
    // In rotation order, then the finished ones, then the discarded ones.
    .sort((a, b) => sortWeight(a) - sortWeight(b));

  return {
    settings,
    stats,
    history,
    actions,
    status,
    watchers: await computeWatchers(status),
    lastError,
    campaigns,
    campaignsAt: cached.campaignsAt,
    current: {
      pointsChannel: state.pointsChannel,
      dropChannels: (state.dropTabs ?? []).map((entry) => entry.channel),
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
  // The badge and the notifications come out of here: they have to change
  // language at the same time as the pages, not on the next browser restart.
  if (before.language !== settings.language) {
    i18nReady = initI18n(settings.language);
    await i18nReady;
  }

  if (!settings.enabled) {
    await farm.closeAllTabs();
  } else {
    // Definitely no `await`: `tick()` queries Twitch and opens tabs. The options
    // page has no business waiting for all that to learn the save succeeded.
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

/**
 * Starts again from a fresh window for the extension. Asking for it implies
 * wanting the dedicated window, so the option turns itself on if it was off:
 * without that, the button would do something the next cycle would undo.
 */
async function onRebuildWindow() {
  const settings = await store.setSettings({ dedicatedWindow: true });
  const { placed } = await farm.rebuildWindow(settings);

  // Whatever was missing is reopened by the cycle, without making the popup wait.
  void tick();
  return { ok: true, placed };
}

async function onSwitchNow() {
  await farm.ensureDropsTabs(await store.getSettings(), { force: true });
  await updateBadge();
  return { ok: true };
}

async function onSetCampaignPriority(payload) {
  const settings = await store.getSettings();
  const ignored = new Set(settings.campaignBlacklist);
  const focused = new Set(settings.focusCampaigns);

  // The three slots are mutually exclusive: remove from everywhere before placing.
  ignored.delete(payload.id);
  focused.delete(payload.id);
  if (payload.priority === CAMPAIGN_PRIORITY.IGNORE) ignored.add(payload.id);
  if (payload.priority === CAMPAIGN_PRIORITY.FOCUS) focused.add(payload.id);

  const updated = await store.setSettings({
    campaignBlacklist: [...ignored],
    focusCampaigns: [...focused],
  });
  await farm.ensureDropsTabs(updated, { force: true });
  return { ok: true, settings: updated };
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
  [MSG.SET_CAMPAIGN_PRIORITY]: onSetCampaignPriority,
  [MSG.REBUILD_WINDOW]: onRebuildWindow,
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const check = validateMessage(msg, sender, chrome.runtime.id);
  if (!check.ok || !Object.hasOwn(HANDLERS, check.type)) {
    console.warn("[TDC] message rejeté :", check.error ?? check.type);
    sendResponse({ ok: false, error: check.error ?? "type inconnu" });
    return false;
  }

  // Wait for the migration: no setting may be read or written before it.
  migrated
    .then(() => HANDLERS[check.type](check.payload, sender.tab?.id ?? null))
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: err.message }));
  return true; // asynchronous response
});

chrome.tabs.onRemoved.addListener((tabId) => {
  forgetCountedTab(tabId);
  void store.forgetTab(tabId).then(updateBadge);
});

notify.registerNotificationHandlers(async (actionId) => {
  await store.setActions(setDone(await store.getActions(), actionId, true));
  await updateBadge();
});

// Registered when the module loads, synchronously: the service worker is woken
// and killed constantly, and a listener attached later would miss requests.
registerHeaderCapture();
registerWatchCounter();

// No `tick()` when the module loads: the service worker is woken on every
// message, which would restart the machinery in a loop. The alarm drives it.
void updateBadge();
