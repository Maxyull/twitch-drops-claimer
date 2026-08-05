import test from "node:test";
import assert from "node:assert/strict";

import {
  COUNTED,
  REASON,
  PROGRESS_MAX_AGE_MS,
  SPADE_MAX_AGE_MS,
  SEGMENT_MAX_AGE_MS,
  WARMUP_MS,
  evaluateCounted,
  isCounted,
  progressAdvanced,
  classifyRequest,
} from "../src/lib/counted.js";

const NOW = 1_800_000_000_000;

test("a recent watch ping is the strongest evidence", () => {
  const res = evaluateCounted({ spadeAt: NOW - 10_000 }, { now: NOW });
  assert.equal(res.code, COUNTED.CONFIRMED);
  assert.equal(res.spadeAge, 10_000);
});

test("no ping but segments arriving: we do not conclude negative", () => {
  // Real case: an ad blocker kills the ping without stopping the counting.
  const res = evaluateCounted(
    { spadeAt: null, segmentAt: NOW - 5_000 },
    { now: NOW },
  );
  assert.equal(res.code, COUNTED.STREAMING);
  assert.equal(isCounted(res.code), true);
});

test("the ping outranks the segments", () => {
  const res = evaluateCounted({ spadeAt: NOW - 1_000, segmentAt: NOW - 1_000 }, { now: NOW });
  assert.equal(res.code, COUNTED.CONFIRMED);
});

test("signals that are too old no longer count", () => {
  const vieux = {
    spadeAt: NOW - SPADE_MAX_AGE_MS - 1,
    segmentAt: NOW - SEGMENT_MAX_AGE_MS - 1,
  };
  assert.equal(evaluateCounted(vieux, { now: NOW }).code, COUNTED.NO);
});

test("observed progress is the strongest evidence", () => {
  const res = evaluateCounted({ progressAt: NOW - 60_000 }, { now: NOW });
  assert.equal(res.code, COUNTED.CONFIRMED);
  assert.equal(res.progressAge, 60_000);
});

test("REGRESSION: evidence outranks the player's supposed state", () => {
  // The reported case: "it says not counted but I got drops". Our reading of the
  // player can be wrong, progress cannot. Progress wins.
  const progression = evaluateCounted({ progressAt: NOW }, { now: NOW, playing: false });
  assert.equal(progression.code, COUNTED.CONFIRMED);

  const ping = evaluateCounted({ spadeAt: NOW }, { now: NOW, playing: false });
  assert.equal(ping.code, COUNTED.CONFIRMED);

  const segments = evaluateCounted({ segmentAt: NOW }, { now: NOW, playing: false });
  assert.equal(segments.code, COUNTED.STREAMING);
});

test("with no evidence at all, a stopped player is not counted", () => {
  assert.equal(evaluateCounted({}, { now: NOW, playing: false }).code, COUNTED.NO);
});

test("a \"not counted\" always says why", () => {
  // Three causes, three different moves: without the reason, you search at
  // random. A stopped player is only reported when no evidence contradicts it.
  const arret = evaluateCounted(
    { segmentAt: NOW - SEGMENT_MAX_AGE_MS - 1 },
    { now: NOW, playing: false },
  );
  assert.equal(arret.code, COUNTED.NO);
  assert.equal(arret.reason, REASON.PLAYER_STOPPED);

  const rien = evaluateCounted({}, { now: NOW, since: NOW - WARMUP_MS - 1 });
  assert.equal(rien.code, COUNTED.NO);
  assert.equal(rien.reason, REASON.NO_SIGNAL, "no signal was ever seen");

  const perime = evaluateCounted(
    { segmentAt: NOW - SEGMENT_MAX_AGE_MS - 1 },
    { now: NOW, since: NOW - WARMUP_MS - 1 },
  );
  assert.equal(perime.code, COUNTED.NO);
  assert.equal(perime.reason, REASON.STALE, "something was seen at some point");
});

test("a positive or undecided state carries no reason", () => {
  assert.equal(evaluateCounted({ progressAt: NOW }, { now: NOW }).reason, null);
  assert.equal(evaluateCounted({ segmentAt: NOW }, { now: NOW }).reason, null);
  assert.equal(evaluateCounted({}, { now: NOW, since: NOW }).reason, null);
});

test("progress that is too old proves nothing any more", () => {
  const vieille = { progressAt: NOW - PROGRESS_MAX_AGE_MS - 1 };
  assert.equal(evaluateCounted(vieille, { now: NOW }).code, COUNTED.NO);
});

test("progressAdvanced only accepts two numbers and a real increase", () => {
  assert.equal(progressAdvanced(10, 11), true);
  assert.equal(progressAdvanced(10, 10), false, "standing still is not progress");
  assert.equal(progressAdvanced(10, 9), false);
  assert.equal(progressAdvanced(undefined, 5), false, "first reading, nothing to compare");
  assert.equal(progressAdvanced(5, null), false);
  assert.equal(progressAdvanced("10", 11), false);
});

test("no verdict while the tab is still warming up", () => {
  const res = evaluateCounted({}, { now: NOW, since: NOW - 10_000 });
  assert.equal(res.code, COUNTED.UNKNOWN);
  assert.equal(isCounted(res.code), false, "\"in progress\" is not a yes");

  const apres = evaluateCounted({}, { now: NOW, since: NOW - WARMUP_MS - 1 });
  assert.equal(apres.code, COUNTED.NO);
});

test("no signal, no start date", () => {
  assert.equal(evaluateCounted(null, { now: NOW }).code, COUNTED.NO);
  assert.equal(evaluateCounted(undefined, { now: NOW }).spadeAge, null);
});

test("classifyRequest recognises the two signals and nothing else", () => {
  assert.equal(classifyRequest("https://spade.twitch.tv/track?x=1"), "spade");
  assert.equal(
    classifyRequest("https://video-edge-abc.abs.hls.ttvnw.net/v1/segment/xyz.ts"),
    "segment",
  );
  assert.equal(classifyRequest("https://gql.twitch.tv/gql"), null);
  assert.equal(classifyRequest("https://www.twitch.tv/zerator"), null);
});

test("REGRESSION: a domain imitating Twitch is not recognised", () => {
  assert.equal(classifyRequest("https://spade.twitch.tv.evil.example/track"), null);
  assert.equal(classifyRequest("https://ttvnw.net.evil.example/x"), null);
  assert.equal(classifyRequest("https://evil-ttvnw.net/x"), null);
  assert.equal(classifyRequest("http://spade.twitch.tv/track"), null, "HTTP refused");
  assert.equal(classifyRequest("not a url"), null);
  assert.equal(classifyRequest(null), null);
});
