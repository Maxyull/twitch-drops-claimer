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
  shuffle,
  pickChannel,
  isCategoryWide,
} from "../src/lib/campaigns.js";
import { campaignNode, restrictedCampaignNode, unlinkedCampaignNode, DAY, HOUR } from "./fixtures.js";

test("parseCampaign reads the useful fields and converts the dates", () => {
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

test("parseCampaign returns null without an id", () => {
  assert.equal(parseCampaign(null), null);
  assert.equal(parseCampaign({}), null);
  assert.deepEqual(parseCampaigns([null, {}, campaignNode()]).length, 1);
});

test("dropState tells the four situations apart", () => {
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

test("campaignProgress aggregates and caps the watched time", () => {
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

test("campaignProgress does not count time beyond the tier", () => {
  const node = campaignNode();
  node.timeBasedDrops[0].self.currentMinutesWatched = 500;
  const p = campaignProgress(parseCampaign(node));
  assert.equal(p.watched, 60);
});

test("campaignProgress detects a finished campaign", () => {
  const node = campaignNode();
  for (const d of node.timeBasedDrops) d.self.isClaimed = true;
  const p = campaignProgress(parseCampaign(node));
  assert.equal(p.done, true);
  assert.equal(p.claimed, 2);
  assert.equal(nextDrop(parseCampaign(node)), null);
});

test("nextDrop takes the shortest remaining tier", () => {
  const c = parseCampaign(campaignNode());
  assert.equal(nextDrop(c).id, "drop-1");
});

test("claimableDrops lists what is ready", () => {
  const node = campaignNode();
  node.timeBasedDrops[0].self.dropInstanceID = "inst-1";
  const c = parseCampaign(node);
  assert.equal(claimableDrops(c).length, 1);
  assert.equal(claimableDrops(c)[0].dropInstanceID, "inst-1");
});

test("needsAccountLink only fires when the information is known and negative", () => {
  assert.equal(needsAccountLink(parseCampaign(unlinkedCampaignNode())), true);
  assert.equal(needsAccountLink(parseCampaign(campaignNode())), false);
  // Information absent (query without the self field): the campaign is not blocked.
  assert.equal(needsAccountLink(parseCampaign({ id: "z", accountLinkURL: "https://x" })), false);
});

test("isActive takes the status and the date window into account", () => {
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

test("rankCampaigns: by default, whatever expires soonest comes first", () => {
  const ranked = rankCampaigns([make("tard", { endInDays: 10 }), make("tot", { endInDays: 1 })]);
  assert.deepEqual(ranked.map((c) => c.id), ["tot", "tard"]);
});

test("rankCampaigns: the \"closest to done\" strategy", () => {
  const ranked = rankCampaigns(
    [make("loin", { watched: 5, endInDays: 1 }), make("proche", { watched: 55, endInDays: 9 })],
    { strategy: "closestToDone" },
  );
  assert.deepEqual(ranked.map((c) => c.id), ["proche", "loin"]);
});

test("rankCampaigns: the \"Twitch order\" strategy keeps the input order", () => {
  const ranked = rankCampaigns([make("b", { endInDays: 9 }), make("a", { endInDays: 1 })], {
    strategy: "order",
  });
  assert.deepEqual(ranked.map((c) => c.id), ["b", "a"]);
});

test("rankCampaigns discards finished, expired and blacklisted campaigns", () => {
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

test("rankCampaigns: unlinked account, discarded only when the option is on", () => {
  const nonLiee = parseCampaign(unlinkedCampaignNode());
  assert.equal(rankCampaigns([nonLiee]).length, 1);
  assert.equal(rankCampaigns([nonLiee], { onlyLinkedCampaigns: true }).length, 0);
  // The user ticked "done" in the popup: the campaign comes back.
  assert.equal(
    rankCampaigns([nonLiee], { onlyLinkedCampaigns: true, linkedOverrides: ["camp-non-liee"] }).length,
    1,
  );
});

// --- campagnes prioritaires -----------------------------------------------

test("focused campaigns come before everything else", () => {
  const ranked = rankCampaigns(
    [make("normale-urgente", { endInDays: 1 }), make("prioritaire", { endInDays: 30 })],
    { focus: ["prioritaire"] },
  );
  assert.deepEqual(ranked.map((c) => c.id), ["prioritaire", "normale-urgente"]);
});

test("among focused campaigns, the one expiring soonest wins", () => {
  const ranked = rankCampaigns(
    [
      make("p-tard", { endInDays: 20 }),
      make("p-tot", { endInDays: 2 }),
      make("normale", { endInDays: 1 }),
    ],
    { focus: ["p-tard", "p-tot"] },
  );
  assert.deepEqual(ranked.map((c) => c.id), ["p-tot", "p-tard", "normale"]);
});

test("a campaign both focused AND ignored stays discarded", () => {
  // The two settings cannot contradict each other in the interface, but storage
  // can carry both: exclusion wins.
  const ranked = rankCampaigns([make("a"), make("b")], {
    focus: ["a"],
    blacklist: ["a"],
  });
  assert.deepEqual(ranked.map((c) => c.id), ["b"]);
});

test("the rest is shuffled when asked for, the focused ones never are", () => {
  // Fixed draw: the permutation is reproducible, and so is the test.
  const suite = [0.9, 0.1, 0.5, 0.3];
  let i = 0;
  const random = () => suite[i++ % suite.length];

  const campaigns = [
    make("p1", { endInDays: 9 }),
    make("p2", { endInDays: 3 }),
    make("a"),
    make("b"),
    make("c"),
  ];
  const ranked = rankCampaigns(campaigns, {
    focus: ["p1", "p2"],
    randomAfterFocus: true,
    random,
  });

  assert.deepEqual(ranked.slice(0, 2).map((c) => c.id), ["p2", "p1"], "focused ones in order");
  assert.deepEqual(
    ranked.slice(2).map((c) => c.id).sort(),
    ["a", "b", "c"],
    "the rest is present, in a different order",
  );
});

test("shuffle keeps every item and does not touch the input", () => {
  const entree = ["a", "b", "c", "d"];
  const copie = [...entree];
  const melange = shuffle(entree, () => 0.42);
  assert.deepEqual(entree, copie, "input untouched");
  assert.deepEqual(melange.slice().sort(), copie.slice().sort());
});

test("rankCampaigns never returns the input list mutated", () => {
  const input = [make("b", { endInDays: 9 }), make("a", { endInDays: 1 })];
  const copy = [...input];
  rankCampaigns(input);
  assert.deepEqual(input, copy);
});

test("rankCampaigns tolerates empty or null input", () => {
  assert.deepEqual(rankCampaigns(null), []);
  assert.deepEqual(rankCampaigns([null, undefined]), []);
});

// --- picking the channel ------------------------------------------------------

test("pickChannel takes the first allowed channel that is live", () => {
  const c = parseCampaign(restrictedCampaignNode(["alpha", "beta", "gamma"]));
  assert.equal(pickChannel(c, ["GAMMA", "beta"]), "beta");
  assert.equal(pickChannel(c, ["unknown"]), null);
  assert.equal(pickChannel(c, []), null);
});

test("isCategoryWide distingue campagne ouverte et campagne restreinte", () => {
  assert.equal(isCategoryWide(parseCampaign(campaignNode())), true);
  assert.equal(isCategoryWide(parseCampaign(restrictedCampaignNode(["alpha"]))), false);
  // An open campaign has no channel to pick: the caller will look at the category.
  assert.equal(pickChannel(parseCampaign(campaignNode()), ["alpha"]), null);
});
