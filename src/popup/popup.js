// Popup : lecture de l'état du service worker + quelques bascules.
// Tout est posé en textContent, jamais d'injection HTML : les noms de campagnes
// viennent de Twitch et ne sont pas de confiance (docs/SECURITY-AUDIT.md, passe 1).

import { MSG, ROLE, CAMPAIGN_PRIORITY } from "../lib/messaging.js";
import { ACTION_KIND } from "../lib/actions.js";
import { COUNTED } from "../lib/counted.js";
import { t, initI18n, localizeDocument } from "../lib/i18n.js";
import { TABS, filterHistory, normalizeFilter, normalizeTab, tabForKey } from "../lib/tabs.js";

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
  $("globalReason").textContent = statusText(status.global.code);
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

/**
 * Le journal : ce qui a été réclamé, et à quelle heure.
 *
 * Une seule frise pour les drops et les points, dans l'ordre du temps. La
 * question qu'on se pose le matin est « qu'est-ce qui s'est passé cette nuit »,
 * et elle mêle les deux ; le filtre est là pour les cas où on cherche un type
 * précis, pas l'inverse.
 */
function renderHistory(history) {
  const list = $("history");
  const filtre = currentFilter();
  const entries = filterHistory(history, filtre);

  list.replaceChildren();
  $("historyEmpty").hidden = entries.length > 0;
  $("historyEmpty").textContent = history.length
    ? t("popup_history_empty_filter")
    : t("popup_history_empty");

  for (const entry of entries.slice(0, 60)) {
    const li = el("li", `event ${entry.kind === "points" ? "points" : "drop"}`);
    li.append(el("span", "kind"));

    const heure = document.createElement("time");
    const date = new Date(entry.at);
    heure.dateTime = date.toISOString();
    heure.textContent = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    // L'heure exacte au survol : la frise reste compacte, l'information est là.
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
  $("actionsEmpty").hidden = sorted.length > 0;

  // La pastille sur l'onglet : ce qui attend l'utilisateur ne doit pas pouvoir
  // se cacher derrière un onglet fermé.
  const badge = $("liveBadge");
  badge.hidden = open === 0;
  badge.textContent = String(open);
  badge.title = t("popup_section_actions");

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
  const badge = $("campaignsBadge");
  badge.hidden = campaigns.length === 0;
  badge.textContent = String(kept);
  badge.title = campaigns.length
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

// --- onglets --------------------------------------------------------------

// L'onglet ouvert et le filtre du journal sont des préférences d'affichage,
// pas des réglages de fonctionnement : ils restent locaux à la page du popup.
const TAB_KEY = "tdc.tab";
const FILTER_KEY = "tdc.historyFilter";

const tabBtn = (id) => document.querySelector(`.tab[data-tab="${id}"]`);
const currentFilter = () => normalizeFilter(localStorage.getItem(FILTER_KEY));

let activeTab = normalizeTab(localStorage.getItem(TAB_KEY));

/**
 * Le trait sous l'onglet actif, positionné par `transform`.
 * Il est large de 100 px dans la feuille de style et remis à l'échelle ici :
 * animer `width` ou `left` referait la mise en page à chaque image.
 */
function moveUnderline() {
  const btn = tabBtn(activeTab);
  const barre = $("tabUnderline");
  if (!btn || !barre) return;
  const zone = btn.parentElement.getBoundingClientRect();
  const cible = btn.getBoundingClientRect();
  barre.style.transform = `translateX(${cible.left - zone.left}px) scaleX(${cible.width / 100})`;
}

function showTab(id, { focus = false } = {}) {
  activeTab = normalizeTab(id);
  localStorage.setItem(TAB_KEY, activeTab);

  for (const nom of TABS) {
    const btn = tabBtn(nom);
    const panel = document.getElementById(`panel-${nom}`);
    if (!btn || !panel) continue;

    const actif = nom === activeTab;
    btn.setAttribute("aria-selected", String(actif));
    // Un seul onglet atteignable par Tab : c'est le motif ARIA, il évite de
    // devoir traverser toute la barre pour atteindre le contenu.
    btn.tabIndex = actif ? 0 : -1;
    panel.hidden = !actif;
  }

  if (focus) tabBtn(activeTab)?.focus();
  moveUnderline();
  document.querySelector("main").scrollTop = 0;
}

function setupTabs() {
  const barre = document.querySelector(".tabs");

  barre.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".tab");
    if (btn) showTab(btn.dataset.tab);
  });

  barre.addEventListener("keydown", (ev) => {
    const suivant = tabForKey(activeTab, ev.key);
    if (!suivant) return; // les autres touches restent au navigateur
    ev.preventDefault();
    showTab(suivant, { focus: true });
  });

  showTab(activeTab);
  // La largeur des onglets dépend des libellés traduits, qui sont posés juste
  // avant : on repositionne une fois la mise en page faite.
  requestAnimationFrame(moveUnderline);
}

function setupFilter() {
  const seg = document.querySelector(".seg");

  const peindre = () => {
    const actif = currentFilter();
    for (const btn of seg.querySelectorAll(".seg-btn")) {
      const on = btn.dataset.filter === actif;
      btn.classList.toggle("on", on);
      btn.setAttribute("aria-pressed", String(on));
    }
  };

  seg.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".seg-btn");
    if (!btn) return;
    localStorage.setItem(FILTER_KEY, normalizeFilter(btn.dataset.filter));
    peindre();
    void load();
  });

  peindre();
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

  // Les pastilles changent la largeur des onglets : le trait se recale après le
  // rendu, sinon il reste décalé jusqu'au prochain clic.
  moveUnderline();
}

// Read straight from storage rather than through the service worker: the popup
// must be painted in the right language on its very first frame, and a message
// round-trip would show raw keys until it comes back.
const { language = "auto" } = await chrome.storage.local.get("language");
await initI18n(language);

localizeDocument();
setupTabs();
setupFilter();

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
