// Popup : lecture de l'état du service worker + quelques bascules.
// Tout est posé en textContent, jamais d'injection HTML : les noms de campagnes
// viennent de Twitch et ne sont pas de confiance (docs/AUDIT-SECU.md, passe 1).

import { MSG, ROLE, CAMPAIGN_PRIORITY } from "../lib/messaging.js";
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
  // Plusieurs onglets de farm : le voyant reprend le pire des leurs, sinon il
  // afficherait vert alors qu'un des deux est en panne.
  const pireDrops = status.drops.find((s) => !s.green) ?? status.drops[0] ?? null;
  setDot($("dropsDot"), Boolean(pireDrops?.green), pireDrops ? statusText(pireDrops.code) : "");

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
    const badge = el("span", `tag ${tone}`.trim(), t(`counted_${w.counted.code}`));
    // « Non compté » sans explication renvoie chercher au hasard.
    if (w.counted.reason) badge.title = t(`reason_${w.counted.reason}`);
    line1.append(badge);
    body.append(line1);

    const bits = [
      statusText(w.status.code),
      w.counted.reason ? t(`reason_${w.counted.reason}`) : null,
      w.campaignName,
      // Le solde de points dit ce que le visionnage rapporte vraiment, là où un
      // compteur de coffres cliqués ne dit rien.
      typeof w.points === "number"
        ? t("popup_points_balance", [w.points.toLocaleString()])
        : null,
      fmtElapsed(w.since),
    ].filter(Boolean);
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

/** Le drop en cours de farm, en tête : progression, palier suivant, échéance. */
function renderCurrentDrop(campaigns) {
  const box = $("currentDrop");
  const courante = campaigns.find((c) => c.current);
  box.hidden = !courante;
  if (!courante) return;

  box.replaceChildren();
  box.append(el("b", null, courante.name || courante.game || ""));

  const bar = el("div", "bar");
  const fill = el("i");
  fill.style.width = `${courante.progress.pct}%`;
  bar.append(fill);
  box.append(bar);

  const bits = [
    `${courante.progress.pct} %`,
    t("popup_tiers", [String(courante.progress.claimed), String(courante.progress.total)]),
    courante.claimable
      ? t("popup_claimable", [String(courante.claimable)])
      : fmtMinutes(courante.progress.remainingMinutes),
    fmtRemaining(courante.endAt),
  ].filter(Boolean);
  box.append(el("small", null, bits.join(" · ")));
}

/** Le journal : ce qui a été réclamé, et à quelle heure. */
function renderHistory(history) {
  const list = $("history");
  list.replaceChildren();
  $("historyEmpty").hidden = history.length > 0;

  for (const entry of history.slice(0, 60)) {
    const li = el("li", "event");

    const heure = document.createElement("time");
    const date = new Date(entry.at);
    heure.dateTime = date.toISOString();
    heure.textContent = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    heure.title = date.toLocaleString();

    const what = el("div", "what");
    if (entry.kind === "points") {
      what.append(el("b", null, t("popup_history_points")));
      what.append(el("small", null, entry.channel));
    } else {
      what.append(el("b", null, entry.label || t("notif_drop_fallback")));
      what.append(el("small", null, entry.campaign));
    }

    li.append(heure, what);
    list.append(li);
  }
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

/**
 * Toutes les campagnes actives, cochables. Décocher une campagne la sort de la
 * rotation : on ne peut pas choisir ce qu'on ne voit pas, donc on montre tout,
 * y compris ce qui est déjà écarté.
 */
function renderCampaigns(campaigns) {
  const list = $("campaigns");
  list.replaceChildren();
  $("campaignsEmpty").hidden = campaigns.length > 0;

  const kept = campaigns.filter((c) => c.selected).length;
  $("campaignsCount").textContent = campaigns.length
    ? t("popup_campaigns_count", [String(kept), String(campaigns.length)])
    : "";

  for (const c of campaigns) {
    const li = el(
      "li",
      ["camp", c.current ? "current" : "", c.selected ? "" : "excluded"].filter(Boolean).join(" "),
    );

    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = c.selected;
    box.title = t("popup_campaign_include");
    box.addEventListener("change", async () => {
      // Décocher écarte la campagne ; recocher la remet là où elle était,
      // prioritaire comprise.
      const priority = box.checked
        ? c.focus
          ? CAMPAIGN_PRIORITY.FOCUS
          : CAMPAIGN_PRIORITY.NORMAL
        : CAMPAIGN_PRIORITY.IGNORE;

      const res = await send(MSG.SET_CAMPAIGN_PRIORITY, { id: c.id, priority });
      if (!res.ok) {
        box.checked = c.selected;
        renderError({ message: res.error ?? "", at: Date.now() });
        return;
      }
      void load();
    });

    const body = el("div", "body");
    const top = el("div", "top");
    if (c.focus) {
      const star = el("span", "star", "★");
      star.title = t("popup_campaign_focused");
      top.append(star);
    }
    top.append(el("b", null, c.name || c.game || ""));
    top.append(el("span", null, `${c.progress.pct} %`));
    body.append(top);

    const bar = el("div", "bar");
    const fill = el("i");
    fill.style.width = `${c.progress.pct}%`;
    bar.append(fill);
    body.append(bar);

    const bits = [
      c.game,
      t("popup_tiers", [String(c.progress.claimed), String(c.progress.total)]),
      c.claimable
        ? t("popup_claimable", [String(c.claimable)])
        : c.progress.done
          ? t("popup_campaign_done")
          : fmtMinutes(c.progress.remainingMinutes),
      fmtRemaining(c.endAt),
    ].filter(Boolean);
    body.append(el("small", null, bits.join(" · ")));

    li.append(box, body);
    list.append(li);
  }
}

// L'état replié est une préférence d'affichage, pas un réglage de
// fonctionnement : il reste local à la page du popup.
const COLLAPSIBLE = [
  ["campaignsBox", "tdc.campaignsOpen"],
  ["actionsBox", "tdc.actionsOpen"],
  ["historyBox", "tdc.historyOpen"],
];

function setupCollapse() {
  for (const [id, key] of COLLAPSIBLE) {
    const box = $(id);
    // Le journal est replié par défaut : on l'ouvre quand on se pose la question,
    // il n'a pas à repousser le reste du popup vers le bas en permanence.
    const parDefaut = id === "historyBox" ? "0" : "1";
    box.open = (localStorage.getItem(key) ?? parDefaut) !== "0";
    box.addEventListener("toggle", () => localStorage.setItem(key, box.open ? "1" : "0"));
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
  renderCurrentDrop(state.campaigns);
  renderHistory(state.history ?? []);
  renderActions(state.actions);
  renderCampaigns(state.campaigns);
  renderError(state.lastError);
}

localizeDocument();
setupCollapse();

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

$("rebuildWindow").addEventListener("click", async () => {
  const bouton = $("rebuildWindow");
  bouton.disabled = true;
  const res = await send(MSG.REBUILD_WINDOW);
  bouton.disabled = false;

  if (!res.ok) renderError({ message: res.error ?? "", at: Date.now() });
  void load();
});

$("inventory").addEventListener("click", () => {
  // `active: true` explicite : c'est le défaut de Chrome, mais l'écrire dit que
  // cet onglet-là est voulu au premier plan, contrairement à ceux de l'extension.
  chrome.tabs.create({ url: "https://www.twitch.tv/drops/inventory", active: true });
});

$("options").addEventListener("click", () => chrome.runtime.openOptionsPage());

void load();
setInterval(load, 5_000);
