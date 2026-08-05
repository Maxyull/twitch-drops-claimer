// Content script: drives the player, claims, and sends a heartbeat that serves as
// proof of viewing (the popup's green / red indicator).
// It injects no DOM and no style into the page: nothing to prefix, nothing to
// clean up, no possible collision with Twitch.
//
// The `log()` calls go to the page's console and are read by a developer, never
// by a user: they are plain English, not catalogue keys. Anything a user reads
// goes through `_locales` (see src/lib/errors.js).

import { isDropClaimButton, isPointsBonusButton, isDismissOverlayButton } from "../lib/dom-rules.js";
import { MSG, CLAIM_KIND, ROLE } from "../lib/messaging.js";
import { AUDIO_ONLY, chooseQualityIndex } from "../lib/quality.js";

const BEAT_MS = 5_000;
const SCAN_MS = 8_000;
const CLICK_MEMORY_MS = 30_000;

const NOT_A_CHANNEL = new Set([
  "",
  "directory",
  "drops",
  "videos",
  "settings",
  "subscriptions",
  "wallet",
  "inventory",
  "downloads",
  "jobs",
  "p",
  "u",
  "team",
  "search",
  "friends",
  "following",
]);

let config = {
  role: ROLE.PASSIVE,
  enabled: true,
  claimPoints: true,
  farmDrops: true,
  forcePlayer: false,
  quality: "160p30",
  volumePercent: 1,
  muteTabs: true,
  owned: false,
};

let lastHref = location.href;
let qualityMenuTries = 0;
let autoplayBlocked = false;
const clicked = new WeakSet();

function send(type, payload) {
  try {
    return chrome.runtime.sendMessage({ type, payload }).catch(() => null);
  } catch {
    return Promise.resolve(null); // extension context invalidated (reload)
  }
}

function log(...args) {
  console.debug("[TDC]", ...args);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- reading the DOM ----------------------------------------------------------

function currentChannel() {
  const seg = location.pathname.split("/").filter(Boolean)[0]?.toLowerCase() ?? "";
  return NOT_A_CHANNEL.has(seg) ? null : seg;
}

function isVisible(el) {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const style = getComputedStyle(el);
  return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
}

/**
 * A button's context: only the parents' attributes and classes are collected,
 * never their text, otherwise any sentence on the page could swing the decision
 * ("Prime" written elsewhere would block a genuine drop button).
 */
function contextOf(el) {
  const parts = [location.pathname];
  let node = el;
  for (let i = 0; i < 5 && node; i += 1) {
    const cls = typeof node.className === "string" ? node.className : "";
    parts.push(
      cls,
      node.getAttribute?.("data-test-selector") ?? "",
      node.getAttribute?.("data-a-target") ?? "",
    );
    node = node.parentElement;
  }
  return parts.filter(Boolean).join(" ");
}

/**
 * Markers carried by the button's children. Twitch often puts the class that
 * really identifies a control on an inner icon, not on the button nor on its
 * ancestors: without this, the points chest is indistinguishable from the balance.
 */
function innerMarkersOf(btn) {
  const parts = [];
  for (const node of btn.querySelectorAll("*")) {
    const cls = typeof node.className === "string" ? node.className : "";
    if (cls) parts.push(cls);
    const sel = node.getAttribute?.("data-test-selector");
    if (sel) parts.push(sel);
    if (parts.length >= 20) break; // a button needs no more than that to be recognised
  }
  return parts.join(" ");
}

function descriptorOf(btn) {
  const tagged = btn.querySelector("[data-test-selector]");
  return {
    text: (btn.textContent || "").trim().slice(0, 80),
    testSelector:
      btn.getAttribute("data-test-selector") || tagged?.getAttribute("data-test-selector") || "",
    aTarget: btn.getAttribute("data-a-target") || "",
    ariaLabel: btn.getAttribute("aria-label") || "",
    inner: innerMarkersOf(btn),
    context: contextOf(btn),
    visible: isVisible(btn),
    disabled: btn.disabled === true || btn.getAttribute("aria-disabled") === "true",
  };
}

function allButtons() {
  return [...document.querySelectorAll('button, [role="button"]')];
}

/** Readable name of the reward tied to a button (best effort). */
function labelNear(btn) {
  const card = btn.closest("[data-test-selector], article, section, div");
  return (card?.querySelector("h1, h2, h3, h4, p")?.textContent || "").trim().slice(0, 80);
}

// --- player -------------------------------------------------------------------

function applyStoredPrefs() {
  if (!config.forcePlayer) return;
  try {
    localStorage.setItem("video-quality", JSON.stringify({ default: config.quality }));
    localStorage.setItem("volume", String(config.volumePercent / 100));
    localStorage.setItem("video-muted", JSON.stringify({ default: Boolean(config.muteTabs) }));
    localStorage.setItem("mature", "true");
  } catch {
    /* storage refused, of no consequence */
  }
}

/**
 * Twitch leaves several `<video>` elements in the page: sidebar previews, the
 * recommendation banner, ads. `querySelector("video")` returned whichever came
 * first, often a stopped one, and the whole diagnosis started from there: a player
 * reported as paused while the real stream is running.
 * We take the one that is playing, and failing that the biggest.
 *
 * We do NOT filter on `videoWidth > 0`: in audio-only quality the stream has no
 * image at all, and that condition discarded precisely the player to follow.
 * `!paused && readyState >= 2` is enough to discard the stopped previews, which
 * were the real problem.
 */
function videoEl() {
  const videos = [...document.querySelectorAll("video")];
  if (videos.length <= 1) return videos[0] ?? null;

  const playing = videos.filter((v) => !v.paused && v.readyState >= 2);
  const pool = playing.length ? playing : videos;

  return pool.reduce(
    (best, v) => (v.clientWidth * v.clientHeight > best.clientWidth * best.clientHeight ? v : best),
    pool[0],
  );
}

function enforcePlayer() {
  if (!config.forcePlayer) return;
  const video = videoEl();
  if (!video) return;

  // Chrome refuses autoplay with sound without a user gesture: in a background
  // tab, an unmuted player never starts. Muting is therefore what makes farming
  // work, not merely a comfort.
  if (config.muteTabs) {
    if (!video.muted) video.muted = true;
  } else {
    const target = config.volumePercent / 100;
    if (video.muted) video.muted = false;
    if (Math.abs(video.volume - target) > 0.001) video.volume = target;
  }

  if (!video.paused) {
    autoplayBlocked = false;
    return;
  }

  video.play().then(
    () => {
      autoplayBlocked = false;
    },
    (err) => {
      // No longer swallowed: without this the popup says "paused" without
      // explaining that the browser is refusing, and nobody knows what to fix.
      autoplayBlocked = err?.name === "NotAllowedError";
      if (autoplayBlocked) log("autoplay refused by the browser");
    },
  );
}

/** Displayed label of an entry in the quality menu. */
function labelOfOption(radio) {
  const wrapper = radio.closest("label");
  const pointe = radio.id ? document.querySelector(`label[for="${CSS.escape(radio.id)}"]`) : null;
  return (wrapper ?? pointe ?? radio.parentElement)?.textContent?.trim() ?? "";
}

/**
 * Fallback when `localStorage` was not taken into account: set the quality through
 * the player's menu. Two attempts at most, we do not insist.
 *
 * It is also the only reliable path for audio-only: the value written to
 * `localStorage` is merely a preference the player reads back on load.
 */
async function setQualityViaMenu() {
  if (qualityMenuTries >= 2) return;
  qualityMenuTries += 1;

  const gear = document.querySelector('[data-a-target="player-settings-button"]');
  if (!gear) return;
  gear.click();
  await wait(400);

  const qualityItem = document.querySelector('[data-a-target="player-settings-menu-item-quality"]');
  if (!qualityItem) {
    document.body.click();
    return;
  }
  qualityItem.click();
  await wait(400);

  const options = [
    ...document.querySelectorAll('[data-a-target="player-settings-menu"] input[type="radio"]'),
  ];
  const index = chooseQualityIndex(options.map(labelOfOption), config.quality);
  if (index >= 0) {
    options[index].click();
    log("quality set through the menu", labelOfOption(options[index]));
  }
  await wait(200);
  document.body.click();
}

function playerFlags() {
  const video = videoEl();
  const ads = Boolean(
    document.querySelector(
      '[data-a-target="video-ad-label"], [data-a-target="player-ad-notice"], .video-player__container--ad',
    ),
  );
  const offline =
    Boolean(
      document.querySelector(
        '[data-test-selector="offline-embed"], .channel-status-info--offline, [data-a-target="player-overlay-offline"]',
      ),
    ) || (!video && Boolean(currentChannel()) && document.readyState === "complete");

  return {
    blocked: autoplayBlocked,
    paused: video ? video.paused : true,
    currentTime: video ? video.currentTime : 0,
    videoHeight: video ? video.videoHeight : 0,
    ads,
    offline,
  };
}

// --- claims -------------------------------------------------------------------

function clickOnce(btn) {
  if (clicked.has(btn)) return false;
  clicked.add(btn);
  btn.click();
  // Twitch often recreates the button: we forget after a while.
  setTimeout(() => clicked.delete(btn), CLICK_MEMORY_MS);
  return true;
}

async function scan() {
  if (!config.enabled) return;

  if (config.forcePlayer) {
    for (const btn of allButtons()) {
      if (isDismissOverlayButton(descriptorOf(btn))) clickOnce(btn);
    }
  }

  if (config.claimPoints) {
    for (const btn of allButtons()) {
      if (!isPointsBonusButton(descriptorOf(btn))) continue;
      if (clickOnce(btn)) {
        log("points bonus claimed");
        send(MSG.CLAIMED, { kind: CLAIM_KIND.POINTS, channel: currentChannel() });
      }
      break;
    }
  }

  if (config.farmDrops) {
    let claimed = 0;
    for (const btn of allButtons()) {
      if (!isDropClaimButton(descriptorOf(btn))) continue;
      const label = labelNear(btn);
      if (clickOnce(btn)) {
        claimed += 1;
        log("drop claimed", label);
        send(MSG.CLAIMED, { kind: CLAIM_KIND.DROP, label, dropName: label });
        await wait(600); // let Twitch breathe between two clicks
      }
    }
    if (claimed && location.pathname.startsWith("/drops")) send(MSG.INVENTORY_DONE, { claimed });
  }
}

// --- heartbeat ----------------------------------------------------------------

function beat() {
  const flags = playerFlags();
  send(MSG.BEAT, {
    channel: currentChannel(),
    url: location.href,
    role: config.role,
    ...flags,
  });

  // In audio-only, any image at all proves the setting did not take. Otherwise we
  // only step in above 480p. Never during an ad: it has its own picture, and the
  // menu does not apply to it.
  const seuil = config.quality === AUDIO_ONLY ? 0 : 480;
  if (config.forcePlayer && !flags.ads && !flags.paused && flags.videoHeight > seuil) {
    void setQualityViaMenu();
  }
}

// --- lifecycle ----------------------------------------------------------------

async function refreshConfig() {
  const res = await send(MSG.HELLO, { url: location.href });
  if (res && res.role) {
    config = { ...config, ...res };
    applyStoredPrefs();
  }
}

/** Marker for the extension's tabs, to be kept identical on the service worker side. */
const TAB_MARK = "#tdc";

/**
 * Twitch rewrites the URL on every internal navigation and wipes the fragment.
 * Without it the extension could no longer recognise its own tabs after a reload,
 * and would open more alongside them. We put it back.
 */
function keepTabMark() {
  if (!config.owned || location.hash === TAB_MARK) return;
  try {
    history.replaceState(null, "", `${location.pathname}${location.search}${TAB_MARK}`);
  } catch {
    /* navigation refused, of no consequence */
  }
}

function watchSpaNavigation() {
  // Twitch is a single-page application: the URL changes with no page reload.
  setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    qualityMenuTries = 0;
    void refreshConfig();
  }, 2_000);
}

// We only resynchronise on a genuine settings change: the counters are written on
// every claim and would wake every tab for nothing.
const WATCHED_KEYS = new Set(["enabled", "claimPoints", "farmDrops", "quality", "volumePercent"]);
chrome.storage.local.onChanged?.addListener((changes) => {
  if (Object.keys(changes).some((k) => WATCHED_KEYS.has(k))) void refreshConfig();
});

async function start() {
  await refreshConfig();
  applyStoredPrefs();

  setInterval(() => {
    enforcePlayer();
    keepTabMark();
    beat();
  }, BEAT_MS);
  setInterval(() => void scan(), SCAN_MS);
  watchSpaNavigation();

  // A quick first pass, once the page has settled.
  setTimeout(() => {
    enforcePlayer();
    void scan();
    beat();
  }, 3_000);
}

void start();
