// Orchestrator: which campaigns to farm, which channel to watch, which tabs to open.
//
// The French identifiers here (`marques`, `orphelins`, `voulus`, `aChercher`, ...)
// are kept on purpose: #72 settled that renaming them is churn with regression
// risk, for no gain the comments do not already provide.

import {
  parseCampaign,
  rankCampaigns,
  pickChannel,
  isCategoryWide,
  campaignProgress,
  isActive,
  mergeProgress,
  applyLiveSession,
} from "../lib/campaigns.js";
import { buildPendingActions, linkedOverrides, pruneActions } from "../lib/actions.js";
import { mergeClaimed, trimRemembered } from "../lib/claimed-drops.js";
import { HISTORY_KIND, addEntries, makeEntry } from "../lib/history.js";
import { progressAdvanced } from "../lib/counted.js";
import { rankForStreak, streakReachable } from "../lib/streak.js";
import { isTabDead } from "../lib/stall.js";
import { mapLimited } from "../lib/concurrency.js";
import { ERROR, describe } from "../lib/errors.js";
import * as gql from "./gql.js";
import * as store from "../lib/storage.js";

const TWITCH_TABS = "https://www.twitch.tv/*";
/**
 * Marker for the tabs the extension opens. A URL fragment is never sent to the
 * server, Twitch ignores it, and above all it survives an extension reload: it is
 * the only clue left once `storage.session` has been cleared.
 */
export const TAB_MARK = "#tdc";

const INVENTORY_URL = `https://www.twitch.tv/drops/inventory${TAB_MARK}`;
const DETAILS_TTL_MS = 6 * 60 * 60 * 1000;
/** Detail requests in flight at once. Enough to be fast, not enough to annoy Twitch. */
const DETAILS_CONCURRENCY = 6;
/** Guard rail: an account never sees that many campaigns, but we do not loop forever. */
const MAX_DETAILS = 200;

// --- tabs ---------------------------------------------------------------------

async function normalWindows() {
  // Filtered in JS rather than through `windowTypes`, deprecated in getAll().
  return (await chrome.windows.getAll()).filter((w) => w.type === "normal");
}

/**
 * The window that already carries tabs marked by the extension.
 * It is the only way to find it again after a reload, `state.windowId` being lost
 * along with `storage.session`.
 */
async function findOwnWindow() {
  try {
    const tabs = await chrome.tabs.query({ url: TWITCH_TABS });
    return tabs.find((tab) => (tab.url ?? "").includes(TAB_MARK))?.windowId ?? null;
  } catch {
    return null;
  }
}

/** How many tabs still carry our marker, and where. */
async function countMarkedTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: TWITCH_TABS });
    const marques = tabs.filter((tab) => (tab.url ?? "").includes(TAB_MARK));
    return { total: tabs.length, marques: marques.length, fenetres: [...new Set(marques.map((t) => t.windowId))] };
  } catch {
    return { total: -1, marques: -1, fenetres: [] };
  }
}

/**
 * Guard rail against runaway creation: a badly evaluated condition must not be
 * able to produce one window per cycle. Past this delay without success, we
 * prefer to reuse an existing window and say so.
 */
const WINDOW_COOLDOWN_MS = 5 * 60_000;

/**
 * Every window creation leaves a trace that can be read afterwards.
 *
 * Five "extra window" reports gave five different causes, each fixed blind.
 * Without knowing WHY the extension concluded it had no window, all we do is
 * block off paths.
 *
 * To read it from the service worker console:
 *   chrome.storage.local.get("windowLog").then(console.log)
 */
const WINDOW_LOG_MAX = 20;

async function traceWindow(entry) {
  const { windowLog = [] } = await chrome.storage.local.get("windowLog");
  const ligne = { at: Date.now(), ...entry };
  console.warn("[TDC] fenêtre :", ligne);
  await chrome.storage.local.set({
    windowLog: [ligne, ...(Array.isArray(windowLog) ? windowLog : [])].slice(0, WINDOW_LOG_MAX),
  });
  return ligne;
}

async function createDedicatedWindow(windows, contexte = {}) {
  const state = await store.getState();

  if (Date.now() - (state.windowCreatedAt ?? 0) < WINDOW_COOLDOWN_MS) {
    // We have just created one and cannot find it again: something is off, and
    // opening yet another would fix nothing.
    await traceWindow({ action: "refusee-delai", ...contexte });
    await store.setLastError(describe(ERROR.WINDOW));
    return windows.at(-1)?.id ?? null;
  }

  // Create then minimise, in two steps: `state` and `focused` overlap within the
  // same call and Chrome does not guarantee the result.
  const created = await chrome.windows.create({ focused: false });
  try {
    await chrome.windows.update(created.id, { state: "minimized" });
  } catch {
    /* not minimised, never mind, it stays in the background */
  }

  await store.setState({ windowId: created.id, windowCreatedAt: Date.now() });
  await traceWindow({ action: "creee", windowId: created.id, ...contexte });
  return created.id;
}

async function targetWindowId(settings, appelant = "?") {
  const windows = await normalWindows();
  const existe = (id) => id != null && windows.some((w) => w.id === id);

  if (settings?.dedicatedWindow) {
    const state = await store.getState();
    if (existe(state.windowId)) return state.windowId;

    // Before creating one: the extension may already have had a window and lost
    // track of it on reload. Its marked tabs give it away.
    const retrouvee = await findOwnWindow();
    if (existe(retrouvee)) {
      await store.setState({ windowId: retrouvee });
      return retrouvee;
    }

    // The context says why we concluded there was no window: that is precisely
    // the information the five previous fixes were missing.
    return createDedicatedWindow(windows, {
      appelant,
      fenetresNormales: windows.length,
      windowIdMemorise: state.windowId ?? null,
      windowIdVivant: existe(state.windowId),
      fenetreRetrouveeParMarqueur: retrouvee ?? null,
      ongletsMarques: await countMarkedTabs(),
    });
  }

  // Outside the dedicated mode, `windows[0]` is the first in Chrome's list, not
  // the one the user is working in. With a single window it did not show; with
  // several, tabs landed anywhere.
  try {
    const derniere = await chrome.windows.getLastFocused();
    if (derniere?.type === "normal") return derniere.id;
  } catch {
    /* no active window, we fall through below */
  }

  if (windows.length) return windows.at(-1).id;
  return createDedicatedWindow(windows);
}

/**
 * Muting at the tab level, on top of the one the content script applies to the
 * player. Belt and braces on purpose: if the content script fails to load, Twitch
 * starts at the volume the user saved and the tab starts talking on its own.
 * Muting a tab does not require the "tabs" permission; only reading its URL
 * would.
 */
async function applyTabMute(tabId, settings) {
  try {
    await chrome.tabs.update(tabId, { muted: Boolean(settings?.muteTabs) });
  } catch {
    /* no muting available: the content script already silences the player */
  }
}

async function openBackgroundTab(url, { pinned = true } = {}) {
  const settings = await store.getSettings();
  const windowId = await targetWindowId(settings, "ouverture-onglet");
  const tab = await chrome.tabs.create({ url, active: false, pinned, windowId });
  try {
    // Stops Chrome putting the tab to sleep: a discarded tab watches nothing.
    await chrome.tabs.update(tab.id, { autoDiscardable: false });
  } catch {
    /* option missing on some versions, of no consequence */
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
    /* already closed */
  }
}

/** Every tab the extension still has a record of. */
async function ownTabIds(state) {
  return new Set(
    [
      state.pointsTabId,
      state.inventoryTabId,
      ...(state.dropTabs ?? []).map((entry) => entry.tabId),
    ].filter(Boolean),
  );
}

/**
 * Closes the tabs marked by the extension that it no longer has a record of.
 *
 * `storage.session` is cleared on every extension reload: without this cleanup it
 * reopens tabs while the previous ones are still running, and one more minimised
 * window appears every time. The already injected content scripts are invalidated
 * by the reload, so we cannot wait for them to announce themselves: they have to
 * be hunted down.
 *
 * The URL filter on `tabs.query` does not require the `tabs` permission; the host
 * permission on `www.twitch.tv` is enough.
 */
export async function closeOrphanTabs() {
  let tabs;
  try {
    tabs = await chrome.tabs.query({ url: TWITCH_TABS });
  } catch {
    return 0;
  }

  const state = await store.getState();
  const miens = await ownTabIds(state);
  const orphelins = tabs.filter((tab) => (tab.url ?? "").includes(TAB_MARK) && !miens.has(tab.id));
  if (!orphelins.length) return 0;

  // Reclaim the window before emptying its tabs: once they are closed nothing
  // identifies it any more, and we would open a second one right next to the
  // user's.
  if (!state.windowId) await store.setState({ windowId: orphelins[0].windowId });

  for (const tab of orphelins) await closeTab(tab.id);
  // The window that carried them closes by itself with its last tab.
  return orphelins.length;
}

/** Is there still at least one farming tab alive? */
async function anyDropTabAlive(state) {
  for (const entry of state.dropTabs ?? []) {
    if (await tabExists(entry.tabId)) return true;
  }
  return false;
}

/** Any Twitch tab, marked or not: the content script runs in it. */
async function anyTwitchTab() {
  try {
    return (await chrome.tabs.query({ url: TWITCH_TABS }))[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * A marked tab already open on this channel. After an extension reload,
 * `storage.session` is empty and it would reopen what already exists, each
 * opening potentially dragging a window along with it.
 */
async function findMarkedTab(channel) {
  const prefixe = `https://www.twitch.tv/${channel}`;
  try {
    const tabs = await chrome.tabs.query({ url: TWITCH_TABS });
    return (
      tabs.find((tab) => {
        const url = tab.url ?? "";
        return url.includes(TAB_MARK) && url.startsWith(prefixe);
      }) ?? null
    );
  } catch {
    return null;
  }
}

/**
 * Opens or recycles a background tab pointing at a channel.
 * The requested channel is remembered rather than read back from the tab's
 * address: that is what avoids the "tabs" permission (see docs/SECURITY-AUDIT.md).
 */
async function ensureChannelTab(tabId, channel) {
  const url = `https://www.twitch.tv/${channel}${TAB_MARK}`;
  const state = await store.getState();

  if (await tabExists(tabId)) {
    if (state.tabChannels[tabId] !== channel) {
      await chrome.tabs.update(tabId, { url });
      await applyTabMute(tabId, await store.getSettings());
      await store.setState({ tabChannels: { ...state.tabChannels, [tabId]: channel } });
    }
    return tabId;
  }

  // Reclaim a tab already in place rather than opening a duplicate.
  const dejaLa = await findMarkedTab(channel);
  const id = dejaLa?.id ?? (await openBackgroundTab(url));
  if (dejaLa) await applyTabMute(id, await store.getSettings());

  await store.setState({ tabChannels: { ...state.tabChannels, [id]: channel } });
  return id;
}

// --- campaigns ----------------------------------------------------------------

async function getLogin() {
  const { twitchLogin } = await chrome.storage.local.get("twitchLogin");
  if (twitchLogin) return twitchLogin;
  const user = await gql.currentUser();
  if (!user?.login) throw new gql.GqlError("no login on the current user", { kind: "account" });
  await chrome.storage.local.set({ twitchLogin: user.login, twitchUserId: user.id ?? null });
  return user.login;
}

/**
 * The account's numeric id, required by the real-time channel's topics.
 * Returns `null` rather than throwing: without it we simply do not open the
 * connection, and nothing else changes.
 */
export async function getUserId() {
  const { twitchUserId } = await chrome.storage.local.get("twitchUserId");
  if (twitchUserId) return twitchUserId;
  try {
    const user = await gql.currentUser();
    if (!user?.id) return null;
    await chrome.storage.local.set({ twitchUserId: user.id });
    return user.id;
  } catch {
    return null;
  }
}

/**
 * A campaign's structure does not move: tier names, required minutes, allowed
 * channels. Its progress does. Serving `isClaimed` from a six-hour cache made any
 * drop claimed in the meantime invisible, and the counter stayed at zero. So the
 * cache keeps the structure, never the progress.
 */
function forgetProgress(drops) {
  return (drops || []).map((d) => ({
    ...d,
    watchedMinutes: 0,
    isClaimed: false,
    dropInstanceID: null,
  }));
}

/** Campaigns already started, with their real progress. One request. */
export async function inventoryCampaigns() {
  return (await gql.inventory()).map(parseCampaign).filter(Boolean);
}

/**
 * Reloads the campaign list, in full and in a single pass.
 *
 * The inventory gives the exact progress of the campaigns already started. The
 * general list gives all the others, whose details (tiers and allowed channels)
 * have to be fetched one by one: those are the requests we parallelise, otherwise
 * the list would fill up over several cycles.
 */
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
        // Only the structure is cached: storing progress we forbid ourselves from
        // reading back would just take up quota.
        cache[detail.id] = { at: now, campaign: { ...detail, drops: forgetProgress(detail.drops) } };
      } else {
        // Details unavailable: the campaign stays visible, without its tiers.
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
 * Counts the drops actually obtained, from the inventory rather than from our
 * clicks: Twitch can credit a tier without us, and a click can fail.
 */
export async function syncClaimedDrops(campaigns) {
  const { ids, seeded } = await store.getClaimedDrops();
  const merged = mergeClaimed(ids, seeded, campaigns);
  await store.setClaimedDrops(trimRemembered(merged.ids));

  if (!merged.added.length) return 0;

  // The tier's name and its campaign's are looked up: a log that only said "a
  // drop" would be worth no more than a counter.
  const nouveaux = new Set(merged.added);
  const entrees = [];
  for (const campaign of campaigns ?? []) {
    for (const drop of campaign?.drops ?? []) {
      if (!nouveaux.has(drop.id)) continue;
      entrees.push(
        makeEntry({
          kind: HISTORY_KIND.DROP,
          id: drop.id,
          label: drop.name || drop.benefits?.[0]?.name || "",
          campaign: campaign.name || campaign.gameName || "",
        }),
      );
    }
  }

  await store.setHistory(addEntries(await store.getHistory(), entrees));
  await store.bumpStat("drops", entrees[0]?.label ?? "", merged.added.length);
  return merged.added.length;
}

/**
 * Proof of counting through progress: the minutes accumulated on the campaign
 * being followed, and the favourite channel's points balance. It is the slowest
 * signal to arrive, and the only one that cannot be wrong.
 */
const PROOF_TTL_MS = 5 * 60_000;

export async function refreshWatchProof() {
  const state = await store.getState();
  const now = Date.now();
  if (now - (state.proofCheckedAt ?? 0) < PROOF_TTL_MS) return state;

  const marks = { ...(state.marks ?? {}) };
  const proof = { ...(state.proof ?? {}) };

  // One request for every farmed campaign: the proof is per tab, but the
  // inventory carries them all.
  if ((state.dropTabs ?? []).length) {
    try {
      const inventaire = await inventoryCampaigns();
      const minutes = { ...(marks.dropsMinutes ?? {}) };

      for (const entry of state.dropTabs) {
        const current = inventaire.find((c) => c.id === entry.campaignId);
        if (!current) continue;
        const watched = campaignProgress(current).watched;
        if (progressAdvanced(minutes[entry.campaignId], watched)) {
          proof.dropsAt = { ...(proof.dropsAt ?? {}), [entry.campaignId]: now };
        }
        minutes[entry.campaignId] = watched;
      }
      marks.dropsMinutes = minutes;

      // The same response is used to advance what the popup displays. Without it
      // the progress bar stayed on the minutes from the last discovery, half an
      // hour old. See #49.
      const { campaigns } = await store.getCampaigns();
      const fusion = mergeProgress(campaigns, inventaire);
      if (fusion.changed) await store.setCampaigns(fusion.campaigns, { touchDate: false });
    } catch {
      /* API silent: we will try again on the next pass */
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
 * Progress announced by the real-time channel, for one specific tier.
 *
 * The same write as polled progress, but without waiting for the next pass: that
 * is the only difference. The same guard rails apply, including the one that
 * forbids a counter from going backwards.
 */
export async function applyRealtimeDrop({ dropID, watchedMinutes }) {
  const { campaigns } = await store.getCampaigns();
  const res = applyLiveSession(campaigns, { dropID, watchedMinutes });
  if (!res.changed) return null;

  await store.setCampaigns(res.campaigns, { touchDate: false });

  // A minute going up is proof Twitch is counting this viewing.
  const campagne = res.campaigns.find((c) => (c.drops || []).some((d) => d.id === dropID));
  if (!campagne) return res;

  const state = await store.getState();
  await store.setState({
    proof: { ...(state.proof ?? {}), dropsAt: { ...(state.proof?.dropsAt ?? {}), [campagne.id]: Date.now() } },
  });
  return res;
}

/**
 * Numeric ids of the channels currently being watched, kept once and for all.
 * They serve two purposes: live progress, and subscribing to raids, which only
 * announce themselves by channel id.
 *
 * Never throws: without an id we lose an acceleration, not the farming.
 */
export async function refreshChannelIds() {
  const state = await store.getState();
  const voulus = [
    state.pointsChannel,
    ...(state.dropTabs ?? []).map((entry) => entry.channel),
  ].filter(Boolean);

  const ids = { ...(state.channelIds ?? {}) };
  const manquants = [...new Set(voulus.filter((login) => !ids[login]))];

  if (manquants.length) {
    try {
      for (const chaine of await gql.liveChannels(manquants)) ids[chaine.login] = chaine.id;
      await store.setState({ channelIds: ids });
    } catch {
      /* API silent: we will try again on the next pass */
    }
  }

  // Only the channels still being watched are returned: keeping the old ones
  // would make us listen for raids on channels we have left.
  return Object.fromEntries(voulus.filter((login) => ids[login]).map((l) => [l, ids[l]]));
}

/**
 * A raid leaves one of the watched channels.
 *
 * Two things, and they must not be confused:
 *
 * 1. The bonus. Twitch pays it to the viewer who follows the raid. It only makes
 *    sense on the favourite channel, the one the user chose; taking it on a
 *    farming tab would mean harvesting at a stranger's.
 * 2. The drift. Twitch redirects the tab to the raid's target. On a farming tab
 *    that target almost never carries the campaign: the viewing stops counting,
 *    and without this the extension only noticed on the next pass, a minute
 *    later, through a "wrong channel" indicator.
 *
 * @returns {{joined: boolean, redirected: boolean}}
 */
export async function handleRaid({ raidID, sourceChannelId }, settings) {
  const state = await store.getState();
  const ids = state.channelIds ?? {};
  const source = Object.keys(ids).find((login) => String(ids[login]) === String(sourceChannelId));

  const surFavorite = Boolean(source) && source === state.pointsChannel;
  let joined = false;

  if (settings.joinRaids && surFavorite) {
    try {
      joined = (await gql.joinRaid(raidID)).ok;
    } catch {
      /* raid already over or refused: nothing to repair */
    }
  }

  // The farming channel is leaving: replace it straight away rather than wait for
  // the indicator to notice.
  const surFarm = (state.dropTabs ?? []).some((entry) => entry.channel === source);
  if (surFarm) await ensureDropsTabs(settings, { force: true });

  return { joined, redirected: surFarm };
}

/** Points have just been credited: that is proof of counting. */
export async function noteRealtimePoints() {
  const state = await store.getState();
  return store.setState({ proof: { ...(state.proof ?? {}), pointsAt: Date.now() } });
}

/**
 * Live progress, every minute, on the farmed channels.
 *
 * The full inventory is too heavy to request that often: it is touched only every
 * five minutes. `DropCurrentSessionContext` returns one tier and its minutes,
 * which is what the two reference miners do, and it is light enough to follow the
 * counter live.
 *
 * Second, less visible benefit: a minute going up is the surest proof Twitch is
 * counting this viewing. The "counted as a viewer" badge therefore gets it in one
 * minute instead of five.
 */
const LIVE_TTL_MS = 60_000;

export async function refreshLiveProgress() {
  const state = await store.getState();
  const now = Date.now();
  if (now - (state.liveCheckedAt ?? 0) < LIVE_TTL_MS) return state;
  // Fingerprint retired by Twitch: no point asking for it again every minute.
  // The inventory keeps running: we lose freshness, not the measurement.
  if (state.livePersistedGone) return state;

  const tabs = (state.dropTabs ?? []).filter((entry) => entry.channel);
  if (!tabs.length) return store.setState({ liveCheckedAt: now });

  const ids = await refreshChannelIds();
  const proof = { ...(state.proof ?? {}) };
  const marks = { ...(state.marks ?? {}) };
  let campaigns = (await store.getCampaigns()).campaigns;
  let ecrire = false;

  try {
    const minutes = { ...(marks.liveMinutes ?? {}) };

    for (const entry of tabs) {
      const session = await gql.currentDropSession(ids[entry.channel]);
      if (!session) continue;

      if (progressAdvanced(minutes[session.dropID], session.watchedMinutes)) {
        proof.dropsAt = { ...(proof.dropsAt ?? {}), [entry.campaignId]: now };
      }
      minutes[session.dropID] = session.watchedMinutes;

      const applique = applyLiveSession(campaigns, session);
      if (applique.changed) {
        campaigns = applique.campaigns;
        ecrire = true;
      }
    }

    marks.liveMinutes = minutes;
  } catch (err) {
    if (err?.kind === "persisted") {
      console.warn("[TDC] progression en direct indisponible :", err.message);
      return store.setState({ liveCheckedAt: now, livePersistedGone: true });
    }
    // Network or session: we will try again on the next pass, breaking nothing.
    return store.setState({ liveCheckedAt: now });
  }

  if (ecrire) await store.setCampaigns(campaigns, { touchDate: false });
  return store.setState({ liveCheckedAt: now, proof, marks });
}

/**
 * The followed channel's balance, and above all claiming the pending chest.
 *
 * The DOM click stays in place for the tabs the user opens themselves, but it
 * depends on a Twitch CSS class: the day it changes, nothing gets claimed any
 * more and nothing reports it. The API explicitly says a bonus is waiting and
 * confirms it was taken.
 */
const POINTS_TTL_MS = 60_000;

/**
 * Two paths claim the same chest: the API and the DOM click. Without a guard the
 * counter would count twice, which is exactly the defect we are trying to fix. A
 * chest appears roughly every fifteen minutes: a one-minute window cannot merge
 * two legitimate bonuses.
 */
const POINTS_DEDUPE_MS = 60_000;

export async function recordPointsClaim(channel) {
  const state = await store.getState();
  const now = Date.now();

  if (state.lastPointsChannel === channel && now - (state.lastPointsAt ?? 0) < POINTS_DEDUPE_MS) {
    return false;
  }

  await store.setState({ lastPointsChannel: channel, lastPointsAt: now });
  await store.setHistory(
    addEntries(await store.getHistory(), [
      makeEntry({ kind: HISTORY_KIND.POINTS, channel: channel ?? "" }, now),
    ]),
  );
  await store.bumpStat("points", channel ?? "");
  return true;
}

/**
 * Every channel the extension is watching right now: the favourite AND the
 * farming channels.
 *
 * A farming channel is a live stream like any other: it hands out points chests.
 * Until now only the DOM click took them, and that click depends on a Twitch CSS
 * class: the day it changes, nothing gets claimed and nothing reports it. The API
 * explicitly says a chest is waiting.
 */
function watchedChannels(state) {
  return [
    ...new Set([state.pointsChannel, ...(state.dropTabs ?? []).map((e) => e.channel)].filter(Boolean)),
  ];
}

export async function refreshPoints(settings, { force = false } = {}) {
  const state = await store.getState();
  const chaines = watchedChannels(state);
  if (!chaines.length) return null;

  let principale = null;
  for (const channel of chaines) {
    const res = await claimPointsOn(channel, settings, { force });
    // The favourite stays the one the popup displays: it is the one the user
    // chose, the others are only a bonus picked up along the way.
    if (channel === state.pointsChannel) principale = res;
  }
  return principale;
}

/** Balance and pending chest for a single channel. Never throws. */
async function claimPointsOn(channel, settings, { force = false } = {}) {
  const state = await store.getState();
  const vus = state.pointsByChannel ?? {};
  const cached = vus[channel] ?? null;

  // `force` is for the real-time channel: Twitch has just announced a chest, so
  // the cached value is stale by definition and waiting for it to expire would
  // waste the whole point of the announcement.
  if (!force && cached && Date.now() - cached.at < POINTS_TTL_MS) return cached;

  let points;
  try {
    points = await gql.channelPoints(channel);
  } catch {
    return cached; // API silent: keep the last known value
  }
  if (!points) return cached;

  const fresh = {
    channel,
    balance: points.balance,
    hasBonus: Boolean(points.claimId),
    at: Date.now(),
  };
  const patch = { pointsByChannel: { ...vus, [channel]: fresh } };
  if (channel === state.pointsChannel) patch.pointsBalance = fresh;
  await store.setState(patch);

  if (!settings?.claimPoints || !points.claimId) return fresh;
  // The same chest is claimed once, even if we come back to it. The memory is per
  // channel: one global id would lose a channel's chest as soon as another
  // channel claimed one.
  const dejaPris = state.claimedBonusIds ?? {};
  if (dejaPris[channel] === points.claimId) return fresh;

  try {
    const res = await gql.claimCommunityPoints(points.channelId, points.claimId);
    if (!res.ok) return fresh;
  } catch {
    return fresh;
  }

  await store.setState({ claimedBonusIds: { ...dejaPris, [channel]: points.claimId } });
  const compte = await recordPointsClaim(channel);
  return { ...fresh, claimed: compte, channel };
}

/** Updates the "required actions" list and returns the new ones. */
export async function syncActions(campaigns, now = Date.now()) {
  const existing = pruneActions(await store.getActions(), now);
  const { list, added } = buildPendingActions(campaigns, existing, now);
  await store.setActions(list);
  return { list, added };
}

/**
 * Picks what to farm: the highest-ranked campaign that has a channel live.
 * @returns {{campaign: object, channel: string}|null}
 */
export async function pickTarget(campaigns, settings, exclude = {}) {
  const skipCampaigns = exclude.campaigns ?? new Set();
  const skipChannels = exclude.channels ?? new Set();

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
    if (skipCampaigns.has(campaign.id)) continue;

    if (isCategoryWide(campaign)) {
      const streams = await gql.gameDropStreams(campaign.gameSlug, 10);
      const channel = streams.find((c) => !skipChannels.has(c));
      if (channel) return { campaign, channel };
      continue;
    }

    const live = await gql.liveLogins(campaign.channels.map((c) => c.login));
    const channel = pickChannel(campaign, live.filter((c) => !skipChannels.has(c)));
    if (channel) return { campaign, channel };
  }

  return null;
}

// --- maintenance loops --------------------------------------------------------

/**
 * The tab dedicated to channel points, on the first favourite channel that is
 * live. No favourite live: the tab is of no further use, so it gets closed.
 */
export async function ensurePointsTab(settings) {
  const state = await store.getState();

  if (!settings.enabled || !settings.watchFavorite || !settings.favoriteChannels.length) {
    if (state.pointsTabId) await closeTab(state.pointsTabId);
    return store.setState({ pointsTabId: null, pointsChannel: null });
  }

  // `null` and `[]` do not mean the same thing: one is an absence of information,
  // the other is an answer. We never close a tab on information we do not have.
  let live = null;
  try {
    live = await gql.liveChannels(settings.favoriteChannels);
  } catch {
    live = null;
  }

  if (live === null) {
    if (state.pointsChannel && (await tabExists(state.pointsTabId))) return state;
    const fallback = settings.favoriteChannels[0];
    const tabId = await ensureChannelTab(state.pointsTabId, fallback);
    return store.setState({ pointsTabId: tabId, pointsChannel: fallback, pointsSince: Date.now() });
  }

  if (!live.length) {
    if (state.pointsTabId) await closeTab(state.pointsTabId);
    return store.setState({ pointsTabId: null, pointsChannel: null, pointsSince: null });
  }

  const target = pickFavorite(settings, state, live);
  const change = target !== state.pointsChannel;

  const tabId = await ensureChannelTab(state.pointsTabId, target);
  return store.setState({
    pointsTabId: tabId,
    pointsChannel: target,
    pointsSince: change ? Date.now() : (state.pointsSince ?? Date.now()),
  });
}

/**
 * Which of the live favourites to watch.
 *
 * By default we do not zap away from a favourite that works: switching tabs costs
 * a reload and starts from zero. The only reason to switch is a streak bonus
 * still reachable elsewhere and no longer reachable here, because that one does
 * not come round again: it is taken at the start of a stream or not at all.
 */
function pickFavorite(settings, state, live) {
  const logins = live.map((c) => c.login);
  const courante = logins.includes(state.pointsChannel) ? state.pointsChannel : null;
  const now = Date.now();

  if (!settings.watchStreak) {
    return courante ?? settings.favoriteChannels.find((c) => logins.includes(c));
  }

  const candidats = settings.favoriteChannels
    .map((login) => live.find((c) => c.login === login))
    .filter(Boolean)
    .map((c) => ({
      ...c,
      watchedMs: c.login === state.pointsChannel ? now - (state.pointsSince ?? now) : 0,
    }));

  const ordre = rankForStreak(candidats, { now });
  const meilleur = ordre[0] ?? null;
  if (!courante) return meilleur ?? settings.favoriteChannels.find((c) => logins.includes(c));
  if (meilleur === courante) return courante;

  const parLogin = new Map(candidats.map((c) => [c.login, c]));
  const gagne =
    streakReachable(parLogin.get(meilleur), { now }) &&
    !streakReachable(parLogin.get(courante), { now });

  return gagne ? meilleur : courante;
}

/** Is a farming entry still worth keeping? */
async function stillWorth(entry, campaigns, state) {
  if (!(await tabExists(entry.tabId))) return false;

  // A tab that stops answering is dead: the three conditions below would stay
  // true indefinitely and the campaign would keep its slot forever. See #68.
  if (isTabDead(entry, { beatAt: state?.beats?.[entry.tabId]?.at ?? null })) return false;

  const campaign = campaigns.find((c) => c.id === entry.campaignId);
  if (!campaign || !isActive(campaign) || campaignProgress(campaign).done) return false;

  try {
    return (await gql.liveLogins([entry.channel])).includes(entry.channel);
  } catch {
    return true; // API silent: let it run rather than close it by mistake
  }
}

/**
 * Farming tabs, one per campaign, each on a different channel.
 *
 * Twitch probably advances only one stream at a time. We do not settle that on
 * their behalf: the "counted as a viewer" badge on each row says which one is
 * really moving, which is worth more than an assertion.
 */
export async function ensureDropsTabs(settings, { force = false } = {}) {
  const state = await store.getState();
  const actifs = state.dropTabs ?? [];
  const voulus =
    settings.enabled && settings.farmDrops && settings.autoDiscover ? settings.farmTabs : 0;

  if (voulus === 0) {
    for (const entry of actifs) await closeTab(entry.tabId);
    return store.setState({ dropTabs: [] });
  }

  const { campaigns } = await store.getCampaigns();

  const gardes = [];
  if (!force) {
    for (const entry of actifs) {
      if (gardes.length >= voulus) break;
      if (await stillWorth(entry, campaigns, state)) gardes.push(entry);
    }
  }

  const abandonnees = [];
  for (const entry of actifs) {
    if (gardes.some((g) => g.tabId === entry.tabId)) continue;
    abandonnees.push(entry.channel);
    await closeTab(entry.tabId);
  }

  // Two tabs on the same campaign or the same channel would serve no purpose.
  const campagnesPrises = new Set(gardes.map((g) => g.campaignId));
  // The channels we have just dropped are excluded from the same pass: without
  // that, the rotation comes straight back to the dead tab it just closed.
  const chainesPrises = new Set([...gardes.map((g) => g.channel), ...abandonnees]);
  const suite = [...gardes];

  while (suite.length < voulus) {
    const target = await pickTarget(campaigns, settings, {
      campaigns: campagnesPrises,
      channels: chainesPrises,
    });
    if (!target) break;

    const tabId = await ensureChannelTab(null, target.channel);
    suite.push({
      tabId,
      channel: target.channel,
      campaignId: target.campaign.id,
      since: Date.now(),
    });
    campagnesPrises.add(target.campaign.id);
    chainesPrises.add(target.channel);
  }

  return store.setState({ dropTabs: suite });
}

/**
 * Claim sweep: opens (or reloads) the inventory, the content script does the
 * clicking and reports back. In fast mode, we claim directly through the API.
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
          /* we will try again on the next pass */
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

  // A marked inventory tab may be lying around from a previous session: reclaim
  // it rather than open a second one on the same page.
  const dejaLa = await findMarkedTab("drops/inventory");
  const tabId = dejaLa?.id ?? (await openBackgroundTab(INVENTORY_URL));
  if (dejaLa) await chrome.tabs.reload(tabId);

  await store.setState({ inventoryTabId: tabId, inventorySince: Date.now() });
  return { mode: "dom", claimed: 0, tabId };
}

/** Time given to the inventory page to load and click before it is closed. */
const INVENTORY_GRACE_MS = 90_000;

/**
 * The inventory has no business staying open between two passes. It is only kept
 * when it is the sole Twitch tab: it then also serves to pick the integrity token
 * back up, without which nothing works at all.
 */
export async function closeInventoryIfRedundant() {
  const state = await store.getState();
  if (!state.inventoryTabId) return state;
  if (Date.now() - (state.inventorySince ?? 0) < INVENTORY_GRACE_MS) return state;

  const stillNeeded =
    !(await tabExists(state.pointsTabId)) && !(await anyDropTabAlive(state));
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
 * Opens a Twitch tab when there is none, purely so the extension can pick the
 * integrity token back up along the way. The inventory is the best candidate: it
 * is the page needed for claiming anyway.
 */
export async function ensureHarvestTab() {
  const state = await store.getState();
  if (await tabExists(state.inventoryTabId)) return state;
  if (await tabExists(state.pointsTabId)) return state;
  if (await anyDropTabAlive(state)) return state;

  // This tab only serves to pick the integrity token back up, and the content
  // script runs on ALL Twitch tabs: the one the user already has open does just
  // as well. Opening one more, and therefore a window, for a page we already have
  // to hand makes no sense.
  if (await anyTwitchTab()) return state;

  const tabId = await openBackgroundTab(INVENTORY_URL);
  return store.setState({ inventoryTabId: tabId, inventorySince: Date.now() });
}

/**
 * Reclaims the previous session's window. Called at startup, before anything
 * opens a tab: otherwise the first opening creates another one next to the one
 * that already existed.
 */
export async function adoptExistingWindow() {
  const state = await store.getState();
  if (state.windowId) return state.windowId;

  const retrouvee = await findOwnWindow();
  if (retrouvee != null) await store.setState({ windowId: retrouvee });
  return retrouvee;
}

/** Time given to the player to start before the place is handed back. */
const WAKE_VISIBLE_MS = 5_000;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wakes a tab whose player is stuck: it is activated inside ITS window. When the
 * dedicated window is in use the user sees nothing go by, only the extension's
 * minimised window changes its active tab.
 */
export async function wakeTab(tabId) {
  if (!(await tabExists(tabId))) return false;

  let precedent = null;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.active) return true; // already in front, nothing to steal or hand back

    // Note who held the place before taking it.
    const [actif] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    if (actif && actif.id !== tabId) precedent = actif.id;

    await chrome.tabs.update(tabId, { active: true });
  } catch {
    return false;
  }

  if (precedent === null) return true;

  // A few seconds in the foreground are enough to unstick a player. Staying in
  // front any longer would mean confiscating the tab the user was looking at,
  // which is never worth the gain.
  await wait(WAKE_VISIBLE_MS);
  try {
    await chrome.tabs.update(precedent, { active: true });
  } catch {
    /* the previous tab was closed in the meantime */
  }
  return true;
}

/**
 * Gathers the extension's tabs into the target window.
 * @returns {{windowId: number, placed: number}}
 */
export async function regroupTabs(settings) {
  const state = await store.getState();

  const vivants = [];
  for (const tabId of [
    state.pointsTabId,
    ...(state.dropTabs ?? []).map((entry) => entry.tabId),
    state.inventoryTabId,
  ].filter(Boolean)) {
    if (await tabExists(tabId)) vivants.push(tabId);
  }

  // Nothing to move: above all do not create a window to put it in. That is what
  // opened one every cycle back when the extension had no tabs at all.
  if (!vivants.length) return { windowId: state.windowId ?? null, placed: 0 };

  const windowId = await targetWindowId(settings, "regroupement");
  if (windowId == null) return { windowId: null, placed: 0 };

  let placed = 0;
  for (const tabId of vivants) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.windowId !== windowId) await chrome.tabs.move(tabId, { windowId, index: -1 });
      placed += 1;
    } catch {
      /* tab gone in the meantime */
    }
  }
  return { windowId, placed };
}

/**
 * Starts again from a fresh window for the extension and brings its tabs back
 * into it. Useful when the dedicated window has been closed, or when the tabs
 * have ended up scattered across the user's windows.
 */
export async function rebuildWindow(settings) {
  const created = await chrome.windows.create({ focused: false });
  try {
    await chrome.windows.update(created.id, { state: "minimized" });
  } catch {
    /* not minimised, it stays in the background */
  }
  await traceWindow({ action: "creee", appelant: "bouton-refaire", windowId: created.id });
  const blank = created.tabs?.[0]?.id ?? null;
  await store.setState({ windowId: created.id, windowCreatedAt: Date.now() });

  const { placed } = await regroupTabs({ ...settings, dedicatedWindow: true });

  // The blank tab created with the window is only closed once another has
  // replaced it: closing the last tab would close the window we just made.
  if (blank && placed > 0) await closeTab(blank);

  return { windowId: created.id, placed };
}

export async function closeAllTabs() {
  const state = await store.getState();
  await Promise.all([
    closeTab(state.pointsTabId),
    ...(state.dropTabs ?? []).map((entry) => closeTab(entry.tabId)),
    closeTab(state.inventoryTabId),
  ]);
  return store.setState({
    pointsTabId: null,
    pointsChannel: null,
    dropTabs: [],
    inventoryTabId: null,
    tabChannels: {},
  });
}

/** Reapplies muting to every managed tab, after a setting has changed. */
export async function refreshTabMute(settings) {
  const state = await store.getState();
  const tousLesOnglets = [
    state.pointsTabId,
    ...(state.dropTabs ?? []).map((entry) => entry.tabId),
    state.inventoryTabId,
  ];
  for (const tabId of tousLesOnglets) {
    if (tabId && (await tabExists(tabId))) await applyTabMute(tabId, settings);
  }
}

// `openBackgroundTab` stays private: each of the three paths that call it first
// checks a tab does not already exist. Exporting it would open a door where that
// check could be forgotten.
export { tabExists, closeTab };
