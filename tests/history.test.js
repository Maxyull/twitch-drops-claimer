import test from "node:test";
import assert from "node:assert/strict";

import {
  HISTORY_KIND,
  MAX_HISTORY,
  makeEntry,
  addEntries,
  countKind,
} from "../src/lib/history.js";

const NOW = 1_800_000_000_000;

test("an entry carries the time, the kind and a bounded label", () => {
  const e = makeEntry(
    { kind: HISTORY_KIND.DROP, id: "d1", label: "L".repeat(500), campaign: "Sea of Thieves" },
    NOW,
  );
  assert.equal(e.at, NOW);
  assert.equal(e.kind, HISTORY_KIND.DROP);
  assert.equal(e.label.length, 120);
  assert.equal(e.campaign, "Sea of Thieves");
});

test("an unknown kind falls back to drop", () => {
  assert.equal(makeEntry({ kind: "whatever" }, NOW).kind, HISTORY_KIND.DROP);
  assert.equal(makeEntry({ kind: HISTORY_KIND.POINTS }, NOW).kind, HISTORY_KIND.POINTS);
  assert.equal(makeEntry(null, NOW).label, "");
});

test("the most recent first, whatever order they arrive in", () => {
  const journal = addEntries(
    [],
    [
      makeEntry({ id: "a", label: "old" }, NOW - 60_000),
      makeEntry({ id: "b", label: "recent" }, NOW),
    ],
  );
  assert.deepEqual(
    journal.map((e) => e.label),
    ["recent", "old"],
  );
});

test("REGRESSION: a replayed reading does not write a duplicate", () => {
  // Drop counting rereads the inventory on every pass: without this guard the
  // log would grow by an identical line every 30 minutes.
  const un = addEntries([], [makeEntry({ id: "d1", label: "Coffre" }, NOW)]);
  const deux = addEntries(un, [makeEntry({ id: "d1", label: "Chest" }, NOW + 1000)]);

  assert.equal(deux.length, 1);
  assert.equal(deux[0].at, NOW, "the first entry is the one that counts");
});

test("entries without an id do accumulate", () => {
  // A points bonus has no stable id: two chests look alike, and they really are
  // two distinct events.
  let journal = addEntries([], [makeEntry({ kind: "points", channel: "zerator" }, NOW)]);
  journal = addEntries(journal, [makeEntry({ kind: "points", channel: "zerator" }, NOW + 60_000)]);
  assert.equal(journal.length, 2);
});

test("the log is bounded and keeps the most recent", () => {
  const beaucoup = Array.from({ length: MAX_HISTORY + 30 }, (_, i) =>
    makeEntry({ id: `d${i}`, label: `drop ${i}` }, NOW + i),
  );
  const journal = addEntries([], beaucoup);

  assert.equal(journal.length, MAX_HISTORY);
  assert.equal(journal[0].label, `drop ${MAX_HISTORY + 29}`, "the most recent is first");
});

test("nothing to add returns the original list", () => {
  const depart = [makeEntry({ id: "d1" }, NOW)];
  assert.equal(addEntries(depart, []), depart);
  assert.equal(addEntries(depart, null), depart);
  assert.deepEqual(addEntries(null, []), []);
});

test("countKind allows cross-checking against the counters", () => {
  const journal = addEntries(
    [],
    [
      makeEntry({ id: "d1", kind: "drop" }, NOW),
      makeEntry({ kind: "points" }, NOW),
      makeEntry({ kind: "points" }, NOW + 1),
    ],
  );
  assert.equal(countKind(journal, HISTORY_KIND.DROP), 1);
  assert.equal(countKind(journal, HISTORY_KIND.POINTS), 2);
  assert.equal(countKind(null, HISTORY_KIND.DROP), 0);
});
