import test from "node:test";
import assert from "node:assert/strict";

import { DEAD_AFTER_MS, GRACE_MS, isTabDead } from "../src/lib/stall.js";

const NOW = 1_800_000_000_000;
const min = (n) => n * 60_000;

test("a tab that answers regularly is alive", () => {
  const entry = { since: NOW - min(60) };
  assert.equal(isTabDead(entry, { now: NOW, beatAt: NOW - 5_000 }), false);
});

test("a tab that stopped answering is dead", () => {
  const entry = { since: NOW - min(60) };
  assert.equal(isTabDead(entry, { now: NOW, beatAt: NOW - DEAD_AFTER_MS }), true);
});

test("a tab that never answered at all is dead", () => {
  // Exactly the reported case: the tab exists, the channel is live, the campaign
  // is active, and nothing ever comes out of it.
  const entry = { since: NOW - min(30) };
  for (const beatAt of [null, undefined, 0, NaN]) {
    assert.equal(isTabDead(entry, { now: NOW, beatAt }), true, String(beatAt));
  }
});

test("REGRESSION: a freshly opened tab is left alone", () => {
  // A tab that just opened has not had time to load Twitch, let alone send a
  // heartbeat. Judging it right away would close it before it had a chance,
  // and the extension would loop on opening and closing tabs.
  const entry = { since: NOW - min(1) };
  assert.equal(isTabDead(entry, { now: NOW, beatAt: null }), false);
  assert.equal(isTabDead({ since: NOW - GRACE_MS }, { now: NOW, beatAt: null }), true);
});

test("REGRESSION: absence of progress is not a death sentence", () => {
  // Twitch probably advances only one stream at a time, so the second farming
  // tab can legitimately sit at zero progress for hours. This module must not
  // look at progress at all, only at the heartbeat.
  const entry = { since: NOW - min(240), watchedMinutes: 0, progressedAt: null };
  assert.equal(isTabDead(entry, { now: NOW, beatAt: NOW - 10_000 }), false);
});

test("an entry with no opening date claims nothing", () => {
  for (const since of [undefined, null, 0, NaN, "hier"]) {
    assert.equal(isTabDead({ since }, { now: NOW, beatAt: null }), false, String(since));
  }
});

test("the delays are configurable", () => {
  const entry = { since: NOW - min(10) };
  assert.equal(isTabDead(entry, { now: NOW, beatAt: NOW - min(1), deadAfterMs: min(1) }), true);
  assert.equal(isTabDead(entry, { now: NOW, beatAt: null, graceMs: min(30) }), false);
});
