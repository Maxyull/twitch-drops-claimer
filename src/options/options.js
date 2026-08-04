import { DEFAULT_SETTINGS, normalizeChannelList } from "../lib/settings.js";
import { MSG } from "../lib/messaging.js";
import { t, localizeDocument } from "../lib/i18n.js";

const $ = (id) => document.getElementById(id);

const CHECKS = [
  "watchFavorite",
  "watchStreak",
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
const SELECTS = ["priority", "quality"];

let blacklist = new Set();
let focus = new Set();

/**
 * Un envoi qui échoue ne doit jamais passer pour un succès : on renvoie toujours
 * un objet, avec `ok: false` et la raison si le service worker n'a pas voulu.
 */
async function send(type, payload) {
  try {
    const res = await chrome.runtime.sendMessage({ type, payload });
    return res ?? { ok: false, error: "aucune réponse du service worker" };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

function showError(reason) {
  const box = $("error");
  box.hidden = !reason;
  if (reason) {
    box.textContent = t("options_save_failed", [String(reason)]);
    // Un « Enregistré » d'un essai précédent qui traîne à côté d'une erreur
    // envoie exactement le mauvais message.
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

/** Prioritaires d'abord, puis les normales, puis les écartées. */
function campaignOrder(id) {
  if (focus.has(id)) return 0;
  return blacklist.has(id) ? 2 : 1;
}

/**
 * La liste de base, avec une étoile pour mettre une campagne en avant et une
 * case pour l'écarter. Les prioritaires remontent en tête : le choix se fait au
 * début, comme l'ordre réel de la rotation.
 */
function renderCampaigns(campaigns) {
  const list = $("campaigns");
  list.replaceChildren();

  // On réaffiche aussi les campagnes écartées : on ne peut pas remettre en
  // rotation ce qui a disparu de l'écran.
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
      // Une campagne écartée ne peut pas être prioritaire : les deux se contrediraient.
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
 * Tant que les réglages n'ont pas été lus, les champs sont vides. Enregistrer à
 * ce moment-là écrirait ce vide par-dessus les vrais réglages : une liste de
 * chaînes favorites effacée pour avoir cliqué trop tôt. Les boutons ne sont donc
 * actifs qu'une fois le chargement réussi.
 */
function setReady(pret) {
  $("save").disabled = !pret;
  $("reset").disabled = !pret;
}

async function load() {
  const state = await send(MSG.GET_STATE);
  if (!state?.settings) {
    setReady(false);
    showError(state?.error ?? "réglages illisibles");
    return;
  }

  fill(state.settings);
  blacklist = new Set(state.settings.campaignBlacklist || []);
  focus = new Set(state.settings.focusCampaigns || []);
  renderCampaigns(state.campaigns || []);
  setReady(true);
}

localizeDocument();
setReady(false);

$("save").addEventListener("click", async () => {
  const res = await send(MSG.SET_SETTINGS, collect());

  // « Enregistré » ne s'affiche que si ça l'est vraiment. Un refus silencieux
  // est ce qui rend ce genre de panne impossible à diagnostiquer.
  if (!res.ok || !res.settings) {
    showError(res.error ?? "refusé");
    return;
  }

  showError(null);
  fill(res.settings);
  // On relit ce qui a été réellement enregistré : les prioritaires remontent
  // alors en tête, ce qui rend le classement visible plutôt que théorique.
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
