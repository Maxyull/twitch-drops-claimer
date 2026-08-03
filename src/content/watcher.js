// Script de contenu : pilote le lecteur, réclame, et envoie un battement de coeur
// qui sert de preuve de visionnage (voyant vert / rouge du popup).
// Il n'injecte aucun DOM ni aucun style dans la page : rien à préfixer, rien à
// nettoyer, aucune collision possible avec Twitch.

import { isDropClaimButton, isPointsBonusButton, isDismissOverlayButton } from "../lib/dom-rules.js";
import { MSG, CLAIM_KIND, ROLE } from "../lib/messaging.js";

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
};

let lastHref = location.href;
let qualityMenuTries = 0;
let autoplayBlocked = false;
const clicked = new WeakSet();

function send(type, payload) {
  try {
    return chrome.runtime.sendMessage({ type, payload }).catch(() => null);
  } catch {
    return Promise.resolve(null); // contexte d'extension invalidé (rechargement)
  }
}

function log(...args) {
  console.debug("[TDC]", ...args);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- lecture du DOM -------------------------------------------------------

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
 * Contexte d'un bouton : on ne remonte que les attributs et classes des parents,
 * jamais leur texte, sinon une phrase quelconque de la page ferait basculer la
 * décision (« Prime » écrit ailleurs bloquerait un vrai bouton de drop).
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
 * Marqueurs portés par les enfants du bouton. Twitch met souvent la classe qui
 * identifie vraiment un contrôle sur une icône interne, pas sur le bouton ni sur
 * ses ancêtres : sans ça, le coffre de points est indiscernable du solde.
 */
function innerMarkersOf(btn) {
  const parts = [];
  for (const node of btn.querySelectorAll("*")) {
    const cls = typeof node.className === "string" ? node.className : "";
    if (cls) parts.push(cls);
    const sel = node.getAttribute?.("data-test-selector");
    if (sel) parts.push(sel);
    if (parts.length >= 20) break; // un bouton n'a pas besoin de plus pour être reconnu
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

/** Nom lisible de la récompense associée à un bouton (au mieux). */
function labelNear(btn) {
  const card = btn.closest("[data-test-selector], article, section, div");
  return (card?.querySelector("h1, h2, h3, h4, p")?.textContent || "").trim().slice(0, 80);
}

// --- lecteur --------------------------------------------------------------

function applyStoredPrefs() {
  if (!config.forcePlayer) return;
  try {
    localStorage.setItem("video-quality", JSON.stringify({ default: config.quality }));
    localStorage.setItem("volume", String(config.volumePercent / 100));
    localStorage.setItem("video-muted", JSON.stringify({ default: Boolean(config.muteTabs) }));
    localStorage.setItem("mature", "true");
  } catch {
    /* stockage refusé, sans conséquence */
  }
}

/**
 * Twitch laisse plusieurs `<video>` dans la page : aperçus de la barre latérale,
 * bandeau de recommandation, publicité. `querySelector("video")` renvoyait le
 * premier venu, souvent à l'arrêt, et tout le diagnostic partait de là : lecteur
 * dit en pause alors que le vrai flux tourne.
 * On prend celui qui joue, et à défaut le plus grand.
 */
function videoEl() {
  const videos = [...document.querySelectorAll("video")];
  if (videos.length <= 1) return videos[0] ?? null;

  const playing = videos.filter((v) => !v.paused && v.readyState >= 2 && v.videoWidth > 0);
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

  // Chrome refuse la lecture automatique avec du son sans geste de
  // l'utilisateur : dans un onglet d'arrière-plan, un lecteur non coupé ne
  // démarre jamais. La sourdine est donc ce qui fait fonctionner le farm, pas
  // seulement un confort.
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
      // On ne l'avale plus : sans ça, le popup dit « en pause » sans expliquer
      // que c'est le navigateur qui refuse, et personne ne sait quoi corriger.
      autoplayBlocked = err?.name === "NotAllowedError";
      if (autoplayBlocked) log("lecture automatique refusée par le navigateur");
    },
  );
}

/**
 * Repli quand `localStorage` n'a pas été pris en compte : on descend la qualité
 * par le menu du lecteur. Deux tentatives maximum, on n'insiste pas.
 */
async function forceLowestQualityViaMenu() {
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
  const lowest = options[options.length - 1];
  if (lowest) {
    lowest.click();
    log("qualité forcée par le menu");
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

// --- réclamations ---------------------------------------------------------

function clickOnce(btn) {
  if (clicked.has(btn)) return false;
  clicked.add(btn);
  btn.click();
  // Twitch recrée souvent le bouton : on oublie au bout d'un moment.
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
        log("bonus de points réclamé");
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
        log("drop réclamé", label);
        send(MSG.CLAIMED, { kind: CLAIM_KIND.DROP, label, dropName: label });
        await wait(600); // on laisse Twitch respirer entre deux clics
      }
    }
    if (claimed && location.pathname.startsWith("/drops")) send(MSG.INVENTORY_DONE, { claimed });
  }
}

// --- battement de coeur ---------------------------------------------------

function beat() {
  const flags = playerFlags();
  send(MSG.BEAT, {
    channel: currentChannel(),
    url: location.href,
    role: config.role,
    ...flags,
  });

  if (config.forcePlayer && flags.videoHeight > 480 && !flags.paused) {
    void forceLowestQualityViaMenu();
  }
}

// --- cycle de vie ---------------------------------------------------------

async function refreshConfig() {
  const res = await send(MSG.HELLO, { url: location.href });
  if (res && res.role) {
    config = { ...config, ...res };
    applyStoredPrefs();
  }
}

function watchSpaNavigation() {
  // Twitch est une SPA : l'URL change sans rechargement de page.
  setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    qualityMenuTries = 0;
    void refreshConfig();
  }, 2_000);
}

// On ne se resynchronise que sur un vrai changement de réglage : les compteurs
// s'écrivent à chaque réclamation et réveilleraient tous les onglets pour rien.
const WATCHED_KEYS = new Set(["enabled", "claimPoints", "farmDrops", "quality", "volumePercent"]);
chrome.storage.local.onChanged?.addListener((changes) => {
  if (Object.keys(changes).some((k) => WATCHED_KEYS.has(k))) void refreshConfig();
});

async function start() {
  await refreshConfig();
  applyStoredPrefs();

  setInterval(() => {
    enforcePlayer();
    beat();
  }, BEAT_MS);
  setInterval(() => void scan(), SCAN_MS);
  watchSpaNavigation();

  // Premier passage rapide, une fois la page posée.
  setTimeout(() => {
    enforcePlayer();
    void scan();
    beat();
  }, 3_000);
}

void start();
