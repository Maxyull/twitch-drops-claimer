// État factice + bouchon de l'API chrome, pour prévisualiser les vues sans
// Chrome ni compte Twitch. Ne fait pas partie de l'extension livrée.
import { MSG } from "../src/lib/messaging.js";

const DAY = 86_400_000;

export const FAKE_STATE = {
  settings: {
    enabled: true,
    claimPoints: true,
    watchFavorite: true,
    favoriteChannels: ["zerator", "gotaga"],
    farmDrops: true,
    autoDiscover: true,
    claimIntervalMin: 15,
    discoverIntervalMin: 30,
    priority: "endingSoon",
    campaignBlacklist: ["camp-ignoree"],
    onlyLinkedCampaigns: false,
    fastClaim: false,
    volumePercent: 1,
    quality: "160p30",
    notifyDrops: true,
    notifyActions: true,
  },
  stats: {
    drops: 12,
    points: 148,
    lastClaim: Date.now() - 4 * 60_000,
    lastClaimLabel: "Coffre en fer",
  },
  actions: [
    {
      id: "link:camp-2",
      kind: "link",
      campaignId: "camp-2",
      campaignName: "Rust — Twitch Rivals",
      game: "Rust",
      url: "https://example.com/link",
      done: false,
      endAt: Date.now() + 2 * DAY,
    },
    {
      id: "redeem:camp-3:d1",
      kind: "redeem",
      campaignId: "camp-3",
      campaignName: "Warframe — Nuit des Guerriers",
      game: "Warframe",
      dropName: "Skin Excalibur",
      url: "https://example.com/redeem",
      done: true,
      endAt: Date.now() + 5 * DAY,
    },
  ],
  status: {
    points: { code: "ok", green: true, channel: "zerator" },
    drops: { code: "ok", green: true, channel: "steelmage" },
    global: { code: "ok", green: true },
  },
  watchers: [
    {
      role: "points",
      tabId: 101,
      channel: "zerator",
      since: Date.now() - 26 * 60_000,
      campaignName: null,
      status: { code: "ok", green: true },
      counted: { code: "confirmed", spadeAge: 12_000, segmentAge: 2_000 },
    },
    {
      role: "drops",
      tabId: 102,
      channel: "steelmage",
      since: Date.now() - 4 * 60_000,
      campaignName: "Sea of Thieves, Saison 14",
      status: { code: "ads", green: true },
      counted: { code: "streaming", spadeAge: null, segmentAge: 3_000 },
    },
  ],
  lastError: null,
  campaignsAt: Date.now() - 120_000,
  campaigns: [
    {
      id: "camp-1",
      name: "Sea of Thieves — Saison 14",
      game: "Sea of Thieves",
      endAt: Date.now() + 1.5 * DAY,
      progress: { total: 4, claimed: 2, claimable: 1, pct: 62, remainingMinutes: 45, done: false },
      claimable: 1,
      current: true,
    },
    {
      id: "camp-2",
      name: "Rust — Twitch Rivals",
      game: "Rust",
      endAt: Date.now() + 2 * DAY,
      progress: { total: 6, claimed: 0, claimable: 0, pct: 8, remainingMinutes: 110, done: false },
      claimable: 0,
      current: false,
    },
    {
      id: "camp-3",
      name: "Warframe — Nuit des Guerriers",
      game: "Warframe",
      endAt: Date.now() + 9 * DAY,
      progress: { total: 3, claimed: 1, claimable: 0, pct: 41, remainingMinutes: 25, done: false },
      claimable: 0,
      current: false,
    },
  ],
  current: {
    pointsChannel: "zerator",
    dropsChannel: "steelmage",
    dropsCampaignId: "camp-1",
    dropsSince: Date.now() - 26 * 60_000,
  },
};

function buildI18n(dict) {
  return {
    getUILanguage: () => "fr",
    getMessage(key, subs) {
      const entry = dict[key];
      if (!entry) return "";
      let out = entry.message;
      const list = Array.isArray(subs) ? subs : subs == null ? [] : [subs];
      for (const [name, def] of Object.entries(entry.placeholders ?? {})) {
        const index = Number(String(def.content).replace("$", "")) - 1;
        out = out.replaceAll(`$${name.toUpperCase()}$`, list[index] ?? "");
      }
      return out;
    },
  };
}

/** Remplace l'API chrome par un bouchon qui répond FAKE_STATE. */
export async function installChromeStub(state = FAKE_STATE) {
  const current = structuredClone(state);
  const dict = await (await fetch("/_locales/fr/messages.json")).json();

  globalThis.chrome = {
    i18n: buildI18n(dict),
    runtime: {
      id: "preview",
      async sendMessage(msg) {
        if (msg.type === MSG.GET_STATE) return current;
        if (msg.type === MSG.SET_ACTION_DONE) {
          const action = current.actions.find((a) => a.id === msg.payload.id);
          if (action) action.done = msg.payload.done;
          return { ok: true };
        }
        if (msg.type === MSG.SET_SETTINGS) {
          Object.assign(current.settings, msg.payload);
          return { ok: true, settings: current.settings };
        }
        return { ok: true };
      },
      openOptionsPage() {
        location.href = "/dev/options-preview.html";
      },
    },
    tabs: { create: ({ url }) => window.open(url, "_blank") },
  };
  return current;
}

/**
 * Charge une page de l'extension dans la page courante : on récupère son corps
 * et sa feuille de style, puis on importe son script une fois le bouchon posé.
 */
export async function mountExtensionPage(htmlPath, scriptPath) {
  const html = await (await fetch(htmlPath)).text();
  const parsed = new DOMParser().parseFromString(html, "text/html");

  for (const link of parsed.head.querySelectorAll('link[rel="stylesheet"]')) {
    const clone = document.createElement("link");
    clone.rel = "stylesheet";
    clone.href = new URL(link.getAttribute("href"), new URL(htmlPath, location.href)).pathname;
    document.head.append(clone);
  }

  // On retire la balise script de la page d'origine : c'est nous qui importons
  // le module, une fois le bouchon chrome en place.
  document.body.replaceChildren(
    ...[...parsed.body.children].filter((el) => el.tagName !== "SCRIPT"),
  );
  await installChromeStub();
  await import(scriptPath);
}
