import test from "node:test";
import assert from "node:assert/strict";

import { mapLimited } from "../src/lib/concurrency.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("results follow the items' order, not the order they finish in", async () => {
  // The first item is the slowest: if it ended up last in the list, the
  // campaign / details pairing would be wrong.
  const res = await mapLimited([30, 20, 10, 0], 2, async (ms, i) => {
    await new Promise((r) => setTimeout(r, ms));
    return `${i}:${ms}`;
  });
  assert.deepEqual(res, ["0:30", "1:20", "2:10", "3:0"]);
});

test("never more than `limit` executions in flight", async () => {
  let inFlight = 0;
  let max = 0;

  await mapLimited(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
    inFlight += 1;
    max = Math.max(max, inFlight);
    await tick();
    inFlight -= 1;
  });

  assert.ok(max <= 4, `up to ${max} in parallel`);
  assert.equal(max, 4, "the limit must actually be reached, otherwise it is slow for nothing");
});

test("a failure does not cut the batch short", async () => {
  const res = await mapLimited([1, 2, 3], 2, async (n) => {
    if (n === 2) throw new Error("boum");
    return n * 10;
  });
  assert.deepEqual(res, [10, null, 30]);
});

test("the fallback value is the caller's choice", async () => {
  const res = await mapLimited([1], 1, async () => {
    throw new Error("boum");
  }, "failed");
  assert.deepEqual(res, ["failed"]);
});

test("empty or invalid input", async () => {
  assert.deepEqual(await mapLimited([], 4, async () => 1), []);
  assert.deepEqual(await mapLimited(null, 4, async () => 1), []);
  assert.deepEqual(await mapLimited(undefined, 4, async () => 1), []);
});

test("an absurd limit does not block", async () => {
  for (const limit of [0, -3, NaN, 1.7]) {
    assert.deepEqual(await mapLimited([1, 2], limit, async (n) => n), [1, 2], `limite ${limit}`);
  }
});

test("a limit larger than the batch does no harm", async () => {
  const res = await mapLimited([1, 2], 100, async (n) => n * 2);
  assert.deepEqual(res, [2, 4]);
});
