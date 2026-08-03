import test from "node:test";
import assert from "node:assert/strict";

import { mapLimited } from "../src/lib/concurrency.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("les résultats suivent l'ordre des éléments, pas celui des fins", async () => {
  // Le premier élément est le plus lent : s'il finissait en dernier dans la
  // liste, l'appariement campagne / détail serait faux.
  const res = await mapLimited([30, 20, 10, 0], 2, async (ms, i) => {
    await new Promise((r) => setTimeout(r, ms));
    return `${i}:${ms}`;
  });
  assert.deepEqual(res, ["0:30", "1:20", "2:10", "3:0"]);
});

test("jamais plus de `limit` exécutions en vol", async () => {
  let inFlight = 0;
  let max = 0;

  await mapLimited(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
    inFlight += 1;
    max = Math.max(max, inFlight);
    await tick();
    inFlight -= 1;
  });

  assert.ok(max <= 4, `jusqu'à ${max} en parallèle`);
  assert.equal(max, 4, "la limite doit être réellement atteinte, sinon c'est lent pour rien");
});

test("un échec ne coupe pas le lot", async () => {
  const res = await mapLimited([1, 2, 3], 2, async (n) => {
    if (n === 2) throw new Error("boum");
    return n * 10;
  });
  assert.deepEqual(res, [10, null, 30]);
});

test("la valeur de repli est choisie par l'appelant", async () => {
  const res = await mapLimited([1], 1, async () => {
    throw new Error("boum");
  }, "raté");
  assert.deepEqual(res, ["raté"]);
});

test("entrées vides ou invalides", async () => {
  assert.deepEqual(await mapLimited([], 4, async () => 1), []);
  assert.deepEqual(await mapLimited(null, 4, async () => 1), []);
  assert.deepEqual(await mapLimited(undefined, 4, async () => 1), []);
});

test("une limite absurde ne bloque pas", async () => {
  for (const limit of [0, -3, NaN, 1.7]) {
    assert.deepEqual(await mapLimited([1, 2], limit, async (n) => n), [1, 2], `limite ${limit}`);
  }
});

test("la limite dépasse la taille du lot sans dommage", async () => {
  const res = await mapLimited([1, 2], 100, async (n) => n * 2);
  assert.deepEqual(res, [2, 4]);
});
