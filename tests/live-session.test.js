import test from "node:test";
import assert from "node:assert/strict";

import { applyLiveSession, campaignProgress } from "../src/lib/campaigns.js";

const drop = (id, required, watched) => ({
  id,
  name: id,
  requiredMinutes: required,
  watchedMinutes: watched,
  isClaimed: false,
  dropInstanceID: null,
  benefits: [],
});

const campagne = (id, drops) => ({ id, name: id, gameName: "Jeu", channels: [], drops });

test("the live session pushes the relevant tier up", () => {
  const stockees = [campagne("c1", [drop("d1", 60, 12), drop("d2", 120, 12)])];

  const res = applyLiveSession(stockees, { dropID: "d1", watchedMinutes: 19 });
  assert.equal(res.changed, true);
  assert.equal(res.campaigns[0].drops[0].watchedMinutes, 19);
  assert.equal(res.campaigns[0].drops[1].watchedMinutes, 12, "the other tiers do not move");
});

test("REGRESSION: a counter never goes backwards", () => {
  // The inventory and the live session do not refresh at the same rate. An older
  // value arriving after a newer one would pull the bar back down in front of the
  // user.
  const stockees = [campagne("c1", [drop("d1", 60, 40)])];

  const res = applyLiveSession(stockees, { dropID: "d1", watchedMinutes: 35 });
  assert.equal(res.changed, false);
  assert.equal(res.campaigns[0].drops[0].watchedMinutes, 40);
  assert.equal(res.campaigns[0], stockees[0], "aucune copie non plus");
});

test("an identical value writes nothing", () => {
  // The call runs every minute while Twitch counts in whole minutes: most passes
  // change nothing.
  const stockees = [campagne("c1", [drop("d1", 60, 40)])];
  const res = applyLiveSession(stockees, { dropID: "d1", watchedMinutes: 40 });
  assert.equal(res.changed, false);
});

test("an unknown tier creates nothing", () => {
  const stockees = [campagne("c1", [drop("d1", 60, 40)])];
  const res = applyLiveSession(stockees, { dropID: "unknown", watchedMinutes: 99 });
  assert.equal(res.changed, false);
  assert.equal(res.campaigns[0].drops.length, 1);
});

test("an empty or unreadable session touches nothing", () => {
  const stockees = [campagne("c1", [drop("d1", 60, 40)])];

  for (const session of [null, undefined, {}, { dropID: "d1" }, { dropID: "d1", watchedMinutes: "x" }]) {
    const res = applyLiveSession(stockees, session);
    assert.equal(res.changed, false, JSON.stringify(session));
    assert.equal(res.campaigns[0].drops[0].watchedMinutes, 40);
  }
});

test("la barre suit vraiment", () => {
  const stockees = [campagne("c1", [drop("d1", 60, 0)])];
  assert.equal(campaignProgress(stockees[0]).pct, 0);

  const res = applyLiveSession(stockees, { dropID: "d1", watchedMinutes: 30 });
  assert.equal(campaignProgress(res.campaigns[0]).pct, 50);
  assert.equal(campaignProgress(res.campaigns[0]).remainingMinutes, 30);
});

test("no campaign stored: no error", () => {
  assert.deepEqual(applyLiveSession([], { dropID: "d1", watchedMinutes: 3 }), {
    campaigns: [],
    changed: false,
  });
  assert.deepEqual(applyLiveSession(null, null), { campaigns: [], changed: false });
});
