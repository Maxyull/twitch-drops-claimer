import test from "node:test";
import assert from "node:assert/strict";

import {
  DROP_STATE,
  parseCampaign,
  parseCampaigns,
  dropState,
  campaignProgress,
  nextDrop,
  claimableDrops,
  needsAccountLink,
  isActive,
  rankCampaigns,
  pickChannel,
  isCategoryWide,
} from "../src/lib/campaigns.js";
import { campaignNode, restrictedCampaignNode, unlinkedCampaignNode, DAY, HOUR } from "./fixtures.js";

test("parseCampaign lit les champs utiles et convertit les dates", () => {
  const c = parseCampaign(campaignNode());
  assert.equal(c.id, "camp-1");
  assert.equal(c.gameSlug, "jeu-test");
  assert.equal(typeof c.startAt, "number");
  assert.equal(c.drops.length, 2);
  assert.equal(c.drops[0].requiredMinutes, 60);
  assert.equal(c.drops[0].watchedMinutes, 30);
  assert.equal(c.drops[0].benefits[0].name, "Coffre");
});

test("parseCampaign survit aux champs absents", () => {
  const c = parseCampaign({ id: "x" });
  assert.equal(c.name, "");
  assert.deepEqual(c.drops, []);
  assert.deepEqual(c.channels, []);
  assert.equal(c.startAt, null);
  assert.equal(c.isAccountConnected, null);
});

test("parseCampaign renvoie null sans identifiant", () => {
  assert.equal(parseCampaign(null), null);
  assert.equal(parseCampaign({}), null);
  assert.deepEqual(parseCampaigns([null, {}, campaignNode()]).length, 1);
});

test("dropState distingue les quatre situations", () => {
  const c = parseCampaign(campaignNode());
  assert.equal(dropState(c.drops[0]), DROP_STATE.IN_PROGRESS);
  assert.equal(dropState(c.drops[1]), DROP_STATE.TODO);
  assert.equal(dropState({ ...c.drops[0], isClaimed: true }), DROP_STATE.CLAIMED);
  assert.equal(dropState({ ...c.drops[0], dropInstanceID: "i1" }), DROP_STATE.CLAIMABLE);
  assert.equal(
    dropState({ requiredMinutes: 60, watchedMinutes: 60, isClaimed: false, dropInstanceID: null }),
    DROP_STATE.CLAIMABLE,
  );
});

test("campaignProgress agrège et plafonne le temps regardé", () => {
  const c = parseCampaign(campaignNode());
  const p = campaignProgress(c);
  assert.equal(p.total, 2);
  assert.equal(p.required, 180);
  assert.equal(p.watched, 30);
  assert.equal(p.pct, 17);
  assert.equal(p.done, false);
  // Prochain palier : 60 requis, 30 vus.
  assert.equal(p.remainingMinutes, 30);
});

test("campaignProgress ne compte pas le temps au-delà du palier", () => {
  const node = campaignNode();
  node.timeBasedDrops[0].self.currentMinutesWatched = 500;
  const p = campaignProgress(parseCampaign(node));
  assert.equal(p.watched, 60);
});

test("campaignProgress détecte une campagne terminée", () => {
  const node = campaignNode();
  for (const d of node.timeBasedDrops) d.self.isClaimed = true;
  const p = campaignProgress(parseCampaign(node));
  assert.equal(p.done, true);
  assert.equal(p.claimed, 2);
  assert.equal(nextDrop(parseCampaign(node)), null);
});

test("nextDrop prend le palier restant le plus court", () => {
  const c = parseCampaign(campaignNode());
  assert.equal(nextDrop(c).id, "drop-1");
});

test("claimableDrops liste ce qui est prêt", () => {
  const node = campaignNode();
  node.timeBasedDrops[0].self.dropInstanceID = "inst-1";
  const c = parseCampaign(node);
  assert.equal(claimableDrops(c).length, 1);
  assert.equal(claimableDrops(c)[0].dropInstanceID, "inst-1");
});

test("needsAccountLink ne se déclenche que si l'info est connue et négative", () => {
  assert.equal(needsAccountLink(parseCampaign(unlinkedCampaignNode())), true);
  assert.equal(needsAccountLink(parseCampaign(campaignNode())), false);
  // Info absente (requête sans le champ self) : on ne bloque pas la campagne.
  assert.equal(needsAccountLink(parseCampaign({ id: "z", accountLinkURL: "https://x" })), false);
});

test("isActive tient compte du statut et de la fenêtre de dates", () => {
  const now = Date.now();
  assert.equal(isActive(parseCampaign(campaignNode()), now), true);
  assert.equal(isActive(parseCampaign(campaignNode({ status: "EXPIRED" })), now), false);
  const future = campaignNode({ startAt: new Date(now + DAY).toISOString() });
  assert.equal(isActive(parseCampaign(future), now), false);
  const past = campaignNode({ endAt: new Date(now - HOUR).toISOString() });
  assert.equal(isActive(parseCampaign(past), now), false);
});

// --- classement -----------------------------------------------------------

function make(id, { endInDays = 5, watched = 0, required = 60, status = "ACTIVE", extra = {} } = {}) {
  return parseCampaign(
    campaignNode({
      id,
      status,
      endAt: new Date(Date.now() + endInDays * DAY).toISOString(),
      timeBasedDrops: [
        {
          id: `${id}-d1`,
          name: "palier",
          requiredMinutesWatched: required,
          benefitEdges: [],
          self: { isClaimed: false, currentMinutesWatched: watched, dropInstanceID: null },
        },
      ],
      ...extra,
    }),
  );
}

test("rankCampaigns : par défaut, ce qui expire le plus tôt d'abord", () => {
  const ranked = rankCampaigns([make("tard", { endInDays: 10 }), make("tot", { endInDays: 1 })]);
  assert.deepEqual(ranked.map((c) => c.id), ["tot", "tard"]);
});

test("rankCampaigns : stratégie « le plus proche de la fin »", () => {
  const ranked = rankCampaigns(
    [make("loin", { watched: 5, endInDays: 1 }), make("proche", { watched: 55, endInDays: 9 })],
    { strategy: "closestToDone" },
  );
  assert.deepEqual(ranked.map((c) => c.id), ["proche", "loin"]);
});

test("rankCampaigns : stratégie « ordre Twitch » conserve l'ordre d'entrée", () => {
  const ranked = rankCampaigns([make("b", { endInDays: 9 }), make("a", { endInDays: 1 })], {
    strategy: "order",
  });
  assert.deepEqual(ranked.map((c) => c.id), ["b", "a"]);
});

test("rankCampaigns écarte terminées, expirées et liste noire", () => {
  const fini = parseCampaign(
    campaignNode({
      id: "fini",
      timeBasedDrops: [
        {
          id: "d",
          requiredMinutesWatched: 10,
          benefitEdges: [],
          self: { isClaimed: true, currentMinutesWatched: 10, dropInstanceID: null },
        },
      ],
    }),
  );
  const ranked = rankCampaigns(
    [fini, make("expiree", { status: "EXPIRED" }), make("noire"), make("ok")],
    { blacklist: ["noire"] },
  );
  assert.deepEqual(ranked.map((c) => c.id), ["ok"]);
});

test("rankCampaigns : compte non lié, écarté seulement si l'option est active", () => {
  const nonLiee = parseCampaign(unlinkedCampaignNode());
  assert.equal(rankCampaigns([nonLiee]).length, 1);
  assert.equal(rankCampaigns([nonLiee], { onlyLinkedCampaigns: true }).length, 0);
  // L'utilisateur a coché « c'est fait » dans le popup : la campagne repart.
  assert.equal(
    rankCampaigns([nonLiee], { onlyLinkedCampaigns: true, linkedOverrides: ["camp-non-liee"] }).length,
    1,
  );
});

test("rankCampaigns ne renvoie jamais la liste d'entrée mutée", () => {
  const input = [make("b", { endInDays: 9 }), make("a", { endInDays: 1 })];
  const copy = [...input];
  rankCampaigns(input);
  assert.deepEqual(input, copy);
});

test("rankCampaigns tolère une entrée vide ou nulle", () => {
  assert.deepEqual(rankCampaigns(null), []);
  assert.deepEqual(rankCampaigns([null, undefined]), []);
});

// --- choix de la chaîne ---------------------------------------------------

test("pickChannel prend la première chaîne autorisée en direct", () => {
  const c = parseCampaign(restrictedCampaignNode(["alpha", "beta", "gamma"]));
  assert.equal(pickChannel(c, ["GAMMA", "beta"]), "beta");
  assert.equal(pickChannel(c, ["inconnue"]), null);
  assert.equal(pickChannel(c, []), null);
});

test("isCategoryWide distingue campagne ouverte et campagne restreinte", () => {
  assert.equal(isCategoryWide(parseCampaign(campaignNode())), true);
  assert.equal(isCategoryWide(parseCampaign(restrictedCampaignNode(["alpha"]))), false);
  // Une campagne ouverte n'a pas de chaîne à choisir : l'appelant ira voir la catégorie.
  assert.equal(pickChannel(parseCampaign(campaignNode()), ["alpha"]), null);
});
