import { DEFAULT_SETTINGS, normalizeChannelList } from "../lib/settings.js";
import { MSG } from "../lib/messaging.js";
import { t, initI18n, localizeDocument } from "../lib/i18n.js";
import { ERROR, describe, formatError } from "../lib/errors.js";

const $ = (id) => document.getElementById(id);

const CHECKS = [
  "watchFavorite",
  "watchStreak",
  "joinRaids",
  "claimPoints",
  "farmDrops",
  "autoDiscover",
  "onlyLinkedCampaigns",
  "fastClaim",
  "muteTabs",
  "dedicatedWindow",
  "wakeStuckTabs",
  "realtime",
  "notifyDrops",
  "notifyActions",
  "notifyProblems",
  "randomAfterFocus",
];
const NUMBERS = [
  "claimIntervalMin",
  "discoverIntervalMin",
  "rotateIntervalMin",
  "alertAfterMin",
  "farmTabs",
  "volumePercent",
];
const SELECTS = ["priority", "quality", "language"];

let blacklist = new Set();
let focus = new Set();

/**
 * A send that fails must never pass for a success: an object is always returned,
 * with `ok: false` and the reason when the service worker refused.
 */
async function send(type, payload) {
  try {
    const res = await chrome.runtime.sendMessage({ type, payload });
    return res ?? { ok: false, error: describe(ERROR.NO_ANSWER) };
  } catch (err) {
    return { ok: false, error: describe(ERROR.UNKNOWN, [err?.message ?? String(err)]) };
  }
}

/**
 * `entry` is a `{ key, params }` descriptor from src/lib/errors.js, translated
 * here rather than written out where the failure happened (#76).
 */
function showError(entry) {
  const box = $("error");
  const reason = formatError(entry, t);
  box.hidden = !reason;
  if (reason) {
    box.textContent = t("options_save_failed", [reason]);
    // A "Saved" left over from an earlier attempt, sitting next to an error,
    // sends exactly the wrong message.
    $("saved").classList.remove("show");
  }
}

function fill(settings) {
  for (const id of CHECKS) $(id).checked = Boolean(settings[id]);
  for (const id of NUMBERS) $(id).value = settings[id];
  for (const id of SELECTS) $(id).value = settings[id];
  $("favoriteChannels").value = (settings.favoriteChannels || []).join("\n");
}

function collect() {
  const patch = {
    favoriteChannels: normalizeChannelList($("favoriteChannels").value),
    campaignBlacklist: [...blacklist],
    focusCampaigns: [...focus],
  };
  for (const id of CHECKS) patch[id] = $(id).checked;
  for (const id of NUMBERS) patch[id] = Number($(id).value);
  for (const id of SELECTS) patch[id] = $(id).value;
  return patch;
}

/** Focused first, then the normal ones, then the discarded ones. */
function campaignOrder(id) {
  if (focus.has(id)) return 0;
  return blacklist.has(id) ? 2 : 1;
}

/**
 * The base list, with a star to push a campaign to the front and a checkbox to
 * discard it. The focused ones rise to the top: the choice is made at the start,
 * mirroring the rotation's real order.
 */
function renderCampaigns(campaigns) {
  const list = $("campaigns");
  list.replaceChildren();

  // The discarded campaigns are shown again too: you cannot put back into the
  // rotation something that has vanished from the screen.
  const known = new Map(campaigns.map((c) => [c.id, c]));
  for (const id of [...blacklist, ...focus]) {
    if (!known.has(id)) known.set(id, { id, name: id, game: "", progress: null });
  }
  $("campaignsEmpty").hidden = known.size > 0;

  const ordered = [...known.values()].sort((a, b) => campaignOrder(a.id) - campaignOrder(b.id));

  for (const c of ordered) {
    const li = document.createElement("li");

    const star = document.createElement("button");
    star.type = "button";
    star.className = "star";

    const box = document.createElement("input");
    box.type = "checkbox";
    box.title = t("options_ignored_title");

    const paint = () => {
      const prioritaire = focus.has(c.id);
      const ecartee = blacklist.has(c.id);
      li.className = `camp${prioritaire ? " focused" : ""}${ecartee ? " ignored" : ""}`;
      star.textContent = prioritaire ? "★" : "☆";
      star.setAttribute("aria-pressed", String(prioritaire));
      star.title = t(prioritaire ? "options_focus_on" : "options_focus_off");
      box.checked = ecartee;
      // A discarded campaign cannot be focused: the two would contradict each other.
      star.disabled = ecartee;
    };

    star.addEventListener("click", () => {
      if (focus.has(c.id)) focus.delete(c.id);
      else focus.add(c.id);
      paint();
    });

    box.addEventListener("change", () => {
      if (box.checked) {
        blacklist.add(c.id);
        focus.delete(c.id);
      } else {
        blacklist.delete(c.id);
      }
      paint();
    });

    const body = document.createElement("div");
    body.className = "body";
    const name = document.createElement("b");
    name.textContent = c.name || "";
    const meta = document.createElement("small");
    meta.textContent = [c.game, c.progress ? `${c.progress.pct} %` : null]
      .filter(Boolean)
      .join(" · ");
    body.append(name, meta);

    paint();
    li.append(star, body, box);
    list.append(li);
  }
}

/**
 * Until the settings have been read, the fields are empty. Saving at that moment
 * would write that emptiness over the real settings: a list of favourite channels
 * wiped for having clicked too early. The buttons are therefore only enabled once
 * the load has succeeded.
 */
function setReady(pret) {
  $("save").disabled = !pret;
  $("reset").disabled = !pret;
}

async function load() {
  const state = await send(MSG.GET_STATE);
  if (!state?.settings) {
    setReady(false);
    showError(state?.error ?? describe(ERROR.SETTINGS_UNREADABLE));
    return;
  }

  fill(state.settings);
  blacklist = new Set(state.settings.campaignBlacklist || []);
  focus = new Set(state.settings.focusCampaigns || []);
  renderCampaigns(state.campaigns || []);
  setReady(true);
}

// The catalogue is read from the package, so the language is a setting rather
// than whatever the browser happens to be in. It has to be loaded before the
// first paint, otherwise the page shows raw keys for a frame.
const { language = "auto" } = await chrome.storage.local.get("language");
await initI18n(language);
localizeDocument();
setReady(false);

$("save").addEventListener("click", async () => {
  const res = await send(MSG.SET_SETTINGS, collect());

  // "Saved" is only shown when it really is. A silent refusal is what makes this
  // kind of failure impossible to diagnose.
  if (!res.ok || !res.settings) {
    showError(res.error ?? describe(ERROR.REFUSED));
    return;
  }

  showError(null);
  // Changing the language must be visible immediately: asking the user to
  // reopen the page to see their own choice applied is not an answer.
  await initI18n(res.settings.language);
  localizeDocument();
  fill(res.settings);
  // What was actually saved is read back: the focused ones then rise to the top,
  // which makes the ranking visible rather than theoretical.
  void load();
  $("saved").classList.add("show");
  setTimeout(() => $("saved").classList.remove("show"), 1_600);
});

$("reset").addEventListener("click", async () => {
  if (!confirm(t("options_reset_confirm"))) return;
  blacklist = new Set();
  focus = new Set();
  fill(DEFAULT_SETTINGS);
  await send(MSG.SET_SETTINGS, { ...DEFAULT_SETTINGS });
  void load();
});

void load();
