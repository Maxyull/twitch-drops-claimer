import test from "node:test";
import assert from "node:assert/strict";

import { campaignProgress, mergeProgress } from "../src/lib/campaigns.js";

const drop = (id, required, watched, extra = {}) => ({
  id,
  name: id,
  requiredMinutes: required,
  watchedMinutes: watched,
  isClaimed: false,
  dropInstanceID: null,
  benefits: [],
  ...extra,
});

const campagne = (id, drops, extra = {}) => ({
  id,
  name: id,
  gameName: "Jeu",
  channels: [{ id: "1", login: "quelquun", displayName: "QuelquUn" }],
  drops,
  ...extra,
});

test("fresh progress carries into the stored campaigns", () => {
  const stockees = [campagne("c1", [drop("d1", 60, 10)])];
  const frais = [campagne("c1", [drop("d1", 60, 35)])];

  const res = mergeProgress(stockees, frais);
  assert.equal(res.changed, true);
  assert.equal(res.campaigns[0].drops[0].watchedMinutes, 35);
  assert.equal(campaignProgress(res.campaigns[0]).pct, 58, "la barre bouge");
});

test("REGRESSION: the structure does not follow the progress", () => {
  // The inventory does not carry the allowed channels or the rewards the way the
  // campaign details do. Copying the structure over would lose what was expensive
  // to obtain.
  const stockees = [
    campagne("c1", [drop("d1", 60, 0, { benefits: [{ id: "b", name: "Casque", imageURL: "" }] })]),
  ];
  const frais = [campagne("c1", [drop("d1", 60, 12)], { channels: [], name: "" })];

  const res = mergeProgress(stockees, frais);
  const fusionnee = res.campaigns[0];
  assert.equal(fusionnee.drops[0].watchedMinutes, 12);
  assert.deepEqual(fusionnee.drops[0].benefits, [{ id: "b", name: "Casque", imageURL: "" }]);
  assert.equal(fusionnee.channels.length, 1);
  assert.equal(fusionnee.name, "c1");
});

test("a tier that became claimable or claimed carries over too", () => {
  const stockees = [campagne("c1", [drop("d1", 60, 59)])];
  const frais = [campagne("c1", [drop("d1", 60, 60, { dropInstanceID: "inst" })])];

  const res = mergeProgress(stockees, frais);
  assert.equal(res.campaigns[0].drops[0].dropInstanceID, "inst");
  assert.equal(campaignProgress(res.campaigns[0]).claimable, 1);
});

test("REGRESSION: a campaign missing from the inventory keeps its progress", () => {
  // The inventory only lists what the account takes part in. An absence is not a
  // reset, otherwise the bar would drop back on every pass.
  const stockees = [campagne("c1", [drop("d1", 60, 40)]), campagne("c2", [drop("d2", 30, 10)])];
  const frais = [campagne("c1", [drop("d1", 60, 45)])];

  const res = mergeProgress(stockees, frais);
  assert.equal(res.campaigns[0].drops[0].watchedMinutes, 45);
  assert.equal(res.campaigns[1].drops[0].watchedMinutes, 10, "untouched, not reset");
});

test("un palier inconnu de l'inventaire reste tel quel", () => {
  const stockees = [campagne("c1", [drop("d1", 60, 40), drop("d2", 120, 40)])];
  const frais = [campagne("c1", [drop("d1", 60, 55)])];

  const res = mergeProgress(stockees, frais);
  assert.equal(res.campaigns[0].drops[0].watchedMinutes, 55);
  assert.equal(res.campaigns[0].drops[1].watchedMinutes, 40);
});

test("nothing new writes nothing", () => {
  // The call runs every 5 minutes: rewriting identical campaigns would wear down
  // the storage quota for nothing.
  const stockees = [campagne("c1", [drop("d1", 60, 40)])];
  const frais = [campagne("c1", [drop("d1", 60, 40)])];

  const res = mergeProgress(stockees, frais);
  assert.equal(res.changed, false);
  assert.equal(res.campaigns[0], stockees[0], "the same object, no copy");
});

test("an empty or unreadable inventory touches nothing", () => {
  const stockees = [campagne("c1", [drop("d1", 60, 40)])];

  for (const frais of [[], null, undefined, [null]]) {
    const res = mergeProgress(stockees, frais);
    assert.equal(res.changed, false);
    assert.equal(res.campaigns[0].drops[0].watchedMinutes, 40);
  }
});

test("no campaign stored: nothing to merge, no error", () => {
  const res = mergeProgress([], [campagne("c1", [drop("d1", 60, 5)])]);
  assert.deepEqual(res, { campaigns: [], changed: false });
  assert.deepEqual(mergeProgress(null, null), { campaigns: [], changed: false });
});
