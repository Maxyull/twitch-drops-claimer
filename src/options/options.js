import { DEFAULT_SETTINGS, normalizeChannelList } from "../lib/settings.js";
import { MSG, CAMPAIGN_PRIORITY } from "../lib/messaging.js";
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
  "randomAfterFocus",
];
const NUMBERS = ["claimIntervalMin", "discoverIntervalMin", "rotateIntervalMin", "volumePercent"];
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

/**
 * Une place par campagne : prioritaire, normale, ou écartée. Les trois s'excluent,
 * un menu déroulant le dit mieux que deux cases à cocher qui se contredisent.
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

  for (const c of known.values()) {
    const li = document.createElement("li");
    li.className = "camp";

    const choix = document.createElement("select");
    for (const [value, key] of [
      [CAMPAIGN_PRIORITY.FOCUS, "options_priority_focus"],
      [CAMPAIGN_PRIORITY.NORMAL, "options_priority_normal"],
      [CAMPAIGN_PRIORITY.IGNORE, "options_priority_ignore"],
    ]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = t(key);
      choix.append(option);
    }
    choix.value = blacklist.has(c.id)
      ? CAMPAIGN_PRIORITY.IGNORE
      : focus.has(c.id)
        ? CAMPAIGN_PRIORITY.FOCUS
        : CAMPAIGN_PRIORITY.NORMAL;

    choix.addEventListener("change", () => {
      blacklist.delete(c.id);
      focus.delete(c.id);
      if (choix.value === CAMPAIGN_PRIORITY.IGNORE) blacklist.add(c.id);
      if (choix.value === CAMPAIGN_PRIORITY.FOCUS) focus.add(c.id);
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

    li.append(body, choix);
    list.append(li);
  }
}

async function load() {
  const state = await send(MSG.GET_STATE);
  if (!state?.settings) return;
  fill(state.settings);
  blacklist = new Set(state.settings.campaignBlacklist || []);
  focus = new Set(state.settings.focusCampaigns || []);
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
  focus = new Set();
  fill(DEFAULT_SETTINGS);
  await send(MSG.SET_SETTINGS, { ...DEFAULT_SETTINGS });
  void load();
});

void load();
