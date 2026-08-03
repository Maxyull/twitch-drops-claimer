import { DEFAULT_SETTINGS, normalizeChannelList } from "../lib/settings.js";
import { MSG } from "../lib/messaging.js";
import { t, localizeDocument } from "../lib/i18n.js";

const $ = (id) => document.getElementById(id);

const CHECKS = [
  "watchFavorite",
  "claimPoints",
  "farmDrops",
  "autoDiscover",
  "onlyLinkedCampaigns",
  "fastClaim",
  "muteTabs",
  "dedicatedWindow",
  "wakeStuckTabs",
  "notifyDrops",
  "notifyActions",
];
const NUMBERS = ["claimIntervalMin", "discoverIntervalMin", "rotateIntervalMin", "volumePercent"];
const SELECTS = ["priority", "quality"];

let blacklist = new Set();

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
  };
  for (const id of CHECKS) patch[id] = $(id).checked;
  for (const id of NUMBERS) patch[id] = Number($(id).value);
  for (const id of SELECTS) patch[id] = $(id).value;
  return patch;
}

function renderCampaigns(campaigns) {
  const list = $("campaigns");
  list.replaceChildren();

  // rankCampaigns écarte déjà les campagnes ignorées : on les réaffiche pour
  // pouvoir les remettre en rotation.
  const known = new Map(campaigns.map((c) => [c.id, c]));
  for (const id of blacklist) {
    if (!known.has(id)) known.set(id, { id, name: id, game: "", progress: null });
  }
  $("campaignsEmpty").hidden = known.size > 0;

  for (const c of known.values()) {
    const li = document.createElement("li");
    li.className = "camp";

    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = blacklist.has(c.id);
    box.title = t("options_ignored_title");
    box.addEventListener("change", () => {
      if (box.checked) blacklist.add(c.id);
      else blacklist.delete(c.id);
    });

    const body = document.createElement("div");
    body.className = "body";
    const name = document.createElement("b");
    name.textContent = c.name || "";
    const meta = document.createElement("small");
    meta.textContent = [c.game, c.progress ? `${c.progress.pct} %` : null].filter(Boolean).join(" · ");
    body.append(name, meta);

    li.append(box, body);
    list.append(li);
  }
}

async function load() {
  const state = await send(MSG.GET_STATE);
  if (!state?.settings) return;
  fill(state.settings);
  blacklist = new Set(state.settings.campaignBlacklist || []);
  renderCampaigns(state.campaigns || []);
}

localizeDocument();

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
  $("saved").classList.add("show");
  setTimeout(() => $("saved").classList.remove("show"), 1_600);
});

$("reset").addEventListener("click", async () => {
  if (!confirm(t("options_reset_confirm"))) return;
  blacklist = new Set();
  fill(DEFAULT_SETTINGS);
  await send(MSG.SET_SETTINGS, { ...DEFAULT_SETTINGS });
  void load();
});

void load();
