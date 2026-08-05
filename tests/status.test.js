import test from "node:test";
import assert from "node:assert/strict";

import { evaluateBeat, summarize, isGreen, STATUS, BEAT_TIMEOUT_MS } from "../src/lib/status.js";

const NOW = 1_800_000_000_000;

function beat(overrides = {}) {
  return {
    at: NOW,
    channel: "zerator",
    paused: false,
    currentTime: 120,
    videoHeight: 160,
    ads: false,
    offline: false,
    ...overrides,
  };
}

test("green when the player is advancing", () => {
  const s = evaluateBeat(beat(), beat({ at: NOW - 5000, currentTime: 115 }), {
    now: NOW,
    expectedChannel: "zerator",
  });
  assert.equal(s.code, STATUS.OK);
  assert.equal(s.green, true);
  assert.equal(s.channel, "zerator");
});

test("green on the very first heartbeat, with no previous one", () => {
  const s = evaluateBeat(beat(), null, { now: NOW });
  assert.equal(s.code, STATUS.OK);
});

test("rouge : lecteur en pause", () => {
  const s = evaluateBeat(beat({ paused: true }), null, { now: NOW });
  assert.equal(s.code, STATUS.PAUSED);
  assert.equal(s.green, false);
});

test("REGRESSION: playback refused by the browser, told apart from a pause", () => {
  // Same visible symptom as a pause, but neither the cause nor the remedy:
  // saying "paused" sent people looking for a problem where there is none.
  const s = evaluateBeat(beat({ paused: true, blocked: true }), null, { now: NOW });
  assert.equal(s.code, STATUS.BLOCKED);
  assert.equal(s.green, false);
});

test("a block does not mask an offline channel", () => {
  const s = evaluateBeat(beat({ blocked: true, offline: true }), null, { now: NOW });
  assert.equal(s.code, STATUS.OFFLINE);
});

test("red: frozen stream (the video clock has stopped moving)", () => {
  const s = evaluateBeat(beat({ currentTime: 120 }), beat({ at: NOW - 5000, currentTime: 120 }), {
    now: NOW,
  });
  assert.equal(s.code, STATUS.STALLED);
  assert.equal(s.green, false);
});

test("red: no heartbeat for too long", () => {
  const s = evaluateBeat(beat({ at: NOW - BEAT_TIMEOUT_MS - 1 }), null, { now: NOW });
  assert.equal(s.code, STATUS.NO_BEAT);
  assert.equal(s.green, false);
});

test("red: tab closed, channel offline, wrong channel", () => {
  assert.equal(evaluateBeat(beat(), null, { now: NOW, tabExists: false }).code, STATUS.NO_TAB);
  assert.equal(evaluateBeat(beat({ offline: true }), null, { now: NOW }).code, STATUS.OFFLINE);
  assert.equal(
    evaluateBeat(beat({ channel: "another" }), null, { now: NOW, expectedChannel: "zerator" }).code,
    STATUS.WRONG_CHANNEL,
  );
});

test("green during an ad: the time keeps counting", () => {
  const s = evaluateBeat(beat({ ads: true, paused: true }), null, { now: NOW });
  assert.equal(s.code, STATUS.ADS);
  assert.equal(s.green, true);
});

test("disabled is neither green nor an error to fix", () => {
  const s = evaluateBeat(beat(), null, { now: NOW, enabled: false });
  assert.equal(s.code, STATUS.DISABLED);
  assert.equal(s.green, false);
});

test("no heartbeat at all", () => {
  assert.equal(evaluateBeat(null, null, { now: NOW }).code, STATUS.NO_BEAT);
});

test("isGreen tells apart what actually accrues watch time", () => {
  assert.equal(isGreen(STATUS.OK), true);
  assert.equal(isGreen(STATUS.ADS), true);
  assert.equal(isGreen(STATUS.STALLED), false);
  assert.equal(isGreen(STATUS.DISABLED), false);
});

test("REGRESSION: no human-readable label comes out of this module", () => {
  // Interface text lives in _locales, not here: a hardcoded label would escape
  // both translation and the i18n coverage test.
  const state = evaluateBeat(beat(), null, { now: NOW });
  assert.deepEqual(Object.keys(state).sort(), ["age", "channel", "code", "green"]);
});

test("summarize surfaces the first problem", () => {
  const ok = evaluateBeat(beat(), null, { now: NOW });
  const ko = evaluateBeat(beat({ paused: true }), null, { now: NOW });
  assert.equal(summarize([ok, ok]).green, true);
  assert.equal(summarize([ok, ko]).green, false);
  assert.equal(summarize([ok, ko]).code, STATUS.PAUSED);
});

test("summarize ignores disabled indicators", () => {
  const off = evaluateBeat(beat(), null, { now: NOW, enabled: false });
  const ok = evaluateBeat(beat(), null, { now: NOW });
  assert.equal(summarize([off, ok]).green, true);
  assert.equal(summarize([off, off]).code, STATUS.DISABLED);
  assert.equal(summarize([]).green, false);
});
