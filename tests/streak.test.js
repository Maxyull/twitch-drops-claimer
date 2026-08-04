import test from "node:test";
import assert from "node:assert/strict";

import { FRESH_MINUTES, STREAK_MINUTES, rankForStreak, streakReachable } from "../src/lib/streak.js";

const NOW = 1_800_000_000_000;
const min = (n) => n * 60_000;

test("a stream that has just gone live can earn the streak", () => {
  assert.equal(streakReachable({ startedAt: NOW - min(2), watchedMs: 0 }, { now: NOW }), true);
});

test("a stream live for hours earns nothing any more", () => {
  assert.equal(streakReachable({ startedAt: NOW - min(360), watchedMs: 0 }, { now: NOW }), false);
  assert.equal(
    streakReachable({ startedAt: NOW - min(FRESH_MINUTES + 1), watchedMs: 0 }, { now: NOW }),
    false,
  );
});

test("REGRESSION: a streak already earned is not prioritised again", () => {
  // Six minutes are enough for the bonus, and it is not given twice on the same
  // stream. Without this bound the extension would stay glued to the same fresh
  // lieu d'aller chercher la suivante.
  const assez = { startedAt: NOW - min(10), watchedMs: min(STREAK_MINUTES) };
  assert.equal(streakReachable(assez, { now: NOW }), false);
  assert.equal(streakReachable({ ...assez, watchedMs: min(6) }, { now: NOW }), true);
});

test("REGRESSION: with no start date, we do not pretend it is yes", () => {
  // Twitch does not always return `createdAt`. Guessing "it is fresh" would zap
  // away from a working channel for another one for no reason.
  for (const startedAt of [undefined, null, 0, NaN, "hier"]) {
    assert.equal(streakReachable({ startedAt, watchedMs: 0 }, { now: NOW }), false);
  }
});

test("a date in the future is not freshness", () => {
  assert.equal(streakReachable({ startedAt: NOW + min(5), watchedMs: 0 }, { now: NOW }), false);
});

test("the order puts reachable streaks first, the freshest at the top", () => {
  const ordre = rankForStreak(
    [
      { login: "ancienne", startedAt: NOW - min(200), watchedMs: 0 },
      { login: "fraiche", startedAt: NOW - min(12), watchedMs: 0 },
      { login: "toutefraiche", startedAt: NOW - min(1), watchedMs: 0 },
    ],
    { now: NOW },
  );
  assert.deepEqual(ordre, ["toutefraiche", "fraiche", "ancienne"]);
});

test("REGRESSION: with no streak candidate, the user's order is kept", () => {
  // The favourites list is entered in a deliberate order. Sorting by streak must
  // not reinvent it when it has nothing to contribute.
  const saisi = [
    { login: "a", startedAt: NOW - min(300), watchedMs: 0 },
    { login: "b", startedAt: NOW - min(100), watchedMs: 0 },
    { login: "c", startedAt: 0, watchedMs: 0 },
  ];
  assert.deepEqual(rankForStreak(saisi, { now: NOW }), ["a", "b", "c"]);
});

test("the ineligible ones keep their order behind the eligible ones", () => {
  const ordre = rankForStreak(
    [
      { login: "a", startedAt: NOW - min(300), watchedMs: 0 },
      { login: "fraiche", startedAt: NOW - min(3), watchedMs: 0 },
      { login: "b", startedAt: NOW - min(100), watchedMs: 0 },
    ],
    { now: NOW },
  );
  assert.deepEqual(ordre, ["fraiche", "a", "b"]);
});

test("an empty or unreadable list breaks nothing", () => {
  assert.deepEqual(rankForStreak([], { now: NOW }), []);
  assert.deepEqual(rankForStreak(null, { now: NOW }), []);
  assert.deepEqual(rankForStreak([{}, { login: "" }, { login: "a" }], { now: NOW }), ["a"]);
});
