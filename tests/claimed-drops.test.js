import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_REMEMBERED,
  collectClaimedIds,
  mergeClaimed,
  trimRemembered,
} from "../src/lib/claimed-drops.js";

function campagne(id, drops) {
  return { id, drops: drops.map(([dropId, isClaimed]) => ({ id: dropId, isClaimed })) };
}

test("keeps only the tiers Twitch marks as obtained", () => {
  const campaigns = [
    campagne("c1", [["d1", true], ["d2", false]]),
    campagne("c2", [["d3", true]]),
  ];
  assert.deepEqual(collectClaimedIds(campaigns), ["d1", "d3"]);
});

test("a tier obtained without an id is ignored", () => {
  const campaigns = [{ id: "c1", drops: [{ id: "", isClaimed: true }, { isClaimed: true }] }];
  assert.deepEqual(collectClaimedIds(campaigns), []);
});

test("empty or malformed input", () => {
  assert.deepEqual(collectClaimedIds(null), []);
  assert.deepEqual(collectClaimedIds([null, {}, { drops: null }]), []);
});

test("REGRESSION: the first pass does not display the account's history", () => {
  // Without this snapshot the counter would jump from 0 to "every drop ever
  // obtained" on the first search, which means nothing.
  const campaigns = [campagne("c1", [["d1", true], ["d2", true]])];
  const first = mergeClaimed([], false, campaigns);

  assert.deepEqual(first.added, [], "nothing is counted on the first pass");
  assert.deepEqual(first.ids.sort(), ["d1", "d2"], "but everything is remembered");
});

test("after the snapshot, only new tiers count", () => {
  const avant = [campagne("c1", [["d1", true]])];
  const { ids } = mergeClaimed([], false, avant);

  const apres = [campagne("c1", [["d1", true], ["d2", true]])];
  const suite = mergeClaimed(ids, true, apres);

  assert.deepEqual(suite.added, ["d2"]);
  assert.equal(suite.ids.length, 2);
});

test("reading the same thing twice does not count twice", () => {
  const campaigns = [campagne("c1", [["d1", true]])];
  const un = mergeClaimed(["d0"], true, campaigns);
  assert.deepEqual(un.added, ["d1"]);

  const deux = mergeClaimed(un.ids, true, campaigns);
  assert.deepEqual(deux.added, [], "no duplicate on the next pass");
  assert.equal(deux.ids.length, 2);
});

test("a tier reverting to unclaimed removes nothing", () => {
  // Twitch can return a stripped-down campaign: that is no reason to bring a
  // counter back down.
  const connu = mergeClaimed([], true, [campagne("c1", [["d1", true]])]).ids;
  const apres = mergeClaimed(connu, true, [campagne("c1", [["d1", false]])]);
  assert.deepEqual(apres.ids, ["d1"]);
  assert.deepEqual(apres.added, []);
});

test("REGRESSION: a stale claimed state must never count", () => {
  // The campaign structure cache reset `isClaimed` to what it was six hours
  // earlier. A tier claimed in the meantime became invisible, and the counter
  // stayed at zero. Here the two reads arrive out of order.
  const frais = [campagne("c1", [["d1", true]])];
  const perime = [campagne("c1", [["d1", false]])];

  const apresFrais = mergeClaimed([], true, frais);
  assert.deepEqual(apresFrais.added, ["d1"]);

  // A stale read must neither remove anything nor allow a later recount.
  const apresPerime = mergeClaimed(apresFrais.ids, true, perime);
  assert.deepEqual(apresPerime.added, []);
  assert.deepEqual(mergeClaimed(apresPerime.ids, true, frais).added, []);
});

test("the remembered history is bounded, keeping the most recent", () => {
  const beaucoup = Array.from({ length: MAX_REMEMBERED + 50 }, (_, i) => `d${i}`);
  const coupe = trimRemembered(beaucoup);
  assert.equal(coupe.length, MAX_REMEMBERED);
  assert.equal(coupe.at(-1), `d${MAX_REMEMBERED + 49}`);
  assert.deepEqual(trimRemembered(["a", "b"], 5), ["a", "b"]);
  assert.deepEqual(trimRemembered(null), []);
});
