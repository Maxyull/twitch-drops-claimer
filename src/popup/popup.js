// Popup : lecture de l'état du service worker + quelques bascules.
// Tout est posé en textContent, jamais d'injection HTML : les noms de campagnes
// viennent de Twitch et ne sont pas de confiance (docs/AUDIT-SECU.md, passe 1).

import { MSG, ROLE } from "../lib/messaging.js";
import { ACTION_KIND } from "../lib/actions.js";
import { COUNTED } from "../lib/counted.js";
import { t, localizeDocument } from "../lib/i18n.js";

const $ = (id) => document.getElementById(id);
const TOGGLES = ["enabled", "watchFavorite", "farmDrops"];

async function send(type, payload) {
  try {
    const res = await chrome.runtime.sendMessage({ type, payload });
    return res ?? { ok: false, error: "aucune réponse du service worker" };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

function setDot(el, green, title) {
  el.classList.toggle("green", Boolean(green));
  el.classList.toggle("red", !green);
  el.title = title || "";
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function fmtDate(ts) {
  return ts ? new Date(ts).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" }) : "";
}

function fmtRemaining(endAt) {
  if (!endAt) return "";
  const left = endAt - Date.now();
  if (left <= 0) return t("popup_ended");
  const h = Math.floor(left / 3_600_000);
  return h < 48 ? t("popup_end_hours", [String(h)]) : t("popup_end_days", [String(Math.floor(h / 24))]);
}

function fmtMinutes(min) {
  if (min <= 0) return t("popup_ready");
  if (min < 60) return t("popup_left_min", [String(min)]);
  return t("popup_left_hours", [String(Math.floor(min / 60)), String(min % 60)]);
}

// --- rendu ----------------------------------------------------------------

const statusText = (code) => t(`status_${code}`);

/** Classe du badge de comptage : vert prouvé, orange probable, rouge non compté. */
function countedTone(code) {
  if (code === COUNTED.CONFIRMED) return "counted";
  if (code === COUNTED.STREAMING) return "partial";
  if (code === COUNTED.UNKNOWN) return "";
  return "uncounted";
}

function fmtElapsed(since) {
  if (!since) return "";
  const min = Math.floor((Date.now() - since) / 60_000);
  if (min < 1) return t("popup_just_started");
  if (min < 60) return t("popup_elapsed_min", [String(min)]);
  return t("popup_elapsed_hours", [String(Math.floor(min / 60)), String(min % 60)]);
}

/** La liste des chaînes que l'extension regarde vraiment, en arrière-plan. */
function renderWatchers(state) {
  const { status, settings } = state;

  setDot($("globalDot"), status.global.green, statusText(status.global.code));
  setDot($("pointsDot"), status.points.green, statusText(status.points.code));
  setDot($("dropsDot"), status.drops.green, statusText(status.drops.code));

  const list = $("watchers");
  list.replaceChildren();

  const watchers = state.watchers ?? [];
  $("watchersEmpty").hidden = watchers.length > 0;
  if (!watchers.length) {
    $("watchersEmpty").textContent = settings.favoriteChannels.length
      ? t("popup_watchers_empty")
      : t("popup_points_none");
    return;
  }

  for (const w of watchers) {
    const row = el("button", "watcher");
    row.title = t("popup_watcher_focus");
    row.addEventListener("click", () => chrome.tabs.update(w.tabId, { active: true }));

    const dot = el("span", "dot");
    dot.classList.add(w.status.green ? "green" : "red");

    const body = el("div", "body");
    const line1 = el("div", "line1");
    line1.append(el("b", null, w.channel));
    line1.append(
      el("span", "tag", w.role === ROLE.POINTS ? t("popup_tag_points") : t("popup_tag_drops")),
    );
    const tone = countedTone(w.counted.code);
    line1.append(el("span", `tag ${tone}`.trim(), t(`counted_${w.counted.code}`)));
    body.append(line1);

    const bits = [statusText(w.status.code), w.campaignName, fmtElapsed(w.since)].filter(Boolean);
    body.append(el("small", null, bits.join(" · ")));

    row.append(dot, body);
    list.append(row);
  }
}

function renderStats(stats) {
  $("statDrops").textContent = stats.drops;
  $("statPoints").textContent = stats.points;
  $("lastClaim").textContent = stats.lastClaim
    ? t("popup_last_claim", [
        `${fmtDate(stats.lastClaim)}${stats.lastClaimLabel ? `, ${stats.lastClaimLabel}` : ""}`,
      ])
    : t("popup_no_claim");
}

function renderActions(actions) {
  const list = $("actions");
  list.replaceChildren();

  const sorted = [...actions].sort((a, b) => Number(a.done) - Number(b.done));
  const open = sorted.filter((a) => !a.done).length;
  $("actionsCount").textContent = open ? `(${open})` : "";
  $("actionsEmpty").hidden = sorted.length > 0;

  for (const action of sorted) {
    const li = el("li", `action${action.done ? " done" : ""}`);

    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = Boolean(action.done);
    box.title = t("popup_action_check");
    box.addEventListener("change", async () => {
      await send(MSG.SET_ACTION_DONE, { id: action.id, done: box.checked });
      void load();
    });

    const body = el("div", "body");
    body.append(el("b", null, action.campaignName || action.game || ""));
    body.append(
      el(
        "small",
        null,
        action.kind === ACTION_KIND.LINK
          ? t("popup_action_link")
          : `${t("popup_action_redeem")}${action.dropName ? `, ${action.dropName}` : ""}`,
      ),
    );
    if (action.url) {
      const a = el("a", null, t("popup_action_open"));
      a.href = action.url;
      a.target = "_blank";
      a.rel = "noreferrer";
      body.append(a);
    }

    li.append(box, body);
    list.append(li);
  }
}

function renderCampaigns(campaigns) {
  const list = $("campaigns");
  list.replaceChildren();
  $("campaignsEmpty").hidden = campaigns.length > 0;

  for (const c of campaigns.slice(0, 6)) {
    const li = el("li", `camp${c.current ? " current" : ""}`);

    const top = el("div", "top");
    top.append(el("b", null, c.name || c.game || ""));
    top.append(el("span", null, `${c.progress.pct} %`));
    li.append(top);

    const bar = el("div", "bar");
    const fill = el("i");
    fill.style.width = `${c.progress.pct}%`;
    bar.append(fill);
    li.append(bar);

    const bits = [
      c.game,
      t("popup_tiers", [String(c.progress.claimed), String(c.progress.total)]),
      c.claimable
        ? t("popup_claimable", [String(c.claimable)])
        : fmtMinutes(c.progress.remainingMinutes),
      fmtRemaining(c.endAt),
    ].filter(Boolean);
    li.append(el("small", null, bits.join(" · ")));

    list.append(li);
  }
}

function renderError(lastError) {
  const box = $("error");
  box.hidden = !lastError;
  if (lastError) box.textContent = `${lastError.message} (${fmtDate(lastError.at)})`;
}

// --- cycle ----------------------------------------------------------------

async function load() {
  const state = await send(MSG.GET_STATE);
  if (!state?.settings) {
    renderError({ message: state?.error ?? "état indisponible", at: Date.now() });
    return;
  }
  for (const key of TOGGLES) $(key).classList.toggle("on", Boolean(state.settings[key]));
  renderWatchers(state);
  renderStats(state.stats);
  renderActions(state.actions);
  renderCampaigns(state.campaigns);
  renderError(state.lastError);
}

localizeDocument();

for (const key of TOGGLES) {
  $(key).addEventListener("click", async () => {
    const before = $(key).classList.contains("on");
    const on = !before;
    $(key).classList.toggle("on", on);

    const res = await send(MSG.SET_SETTINGS, { [key]: on });
    if (!res.ok) {
      // Une bascule qui reste allumée alors que rien n'a été enregistré ment
      // à l'utilisateur : on la remet où elle était et on affiche la raison.
      $(key).classList.toggle("on", before);
      renderError({ message: res.error ?? "réglage refusé", at: Date.now() });
      return;
    }
    void load();
  });
}

$("refresh").addEventListener("click", async () => {
  $("refresh").textContent = t("popup_btn_searching");
  await send(MSG.REFRESH_NOW);
  $("refresh").textContent = t("popup_btn_refresh");
  void load();
});

$("switch").addEventListener("click", async () => {
  await send(MSG.SWITCH_NOW);
  void load();
});

$("inventory").addEventListener("click", () => {
  chrome.tabs.create({ url: "https://www.twitch.tv/drops/inventory" });
});

$("options").addEventListener("click", () => chrome.runtime.openOptionsPage());

void load();
setInterval(load, 5_000);
