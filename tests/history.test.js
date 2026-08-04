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

test("une entrée porte l'heure, le type et un libellé borné", () => {
  const e = makeEntry(
    { kind: HISTORY_KIND.DROP, id: "d1", label: "L".repeat(500), campaign: "Sea of Thieves" },
    NOW,
  );
  assert.equal(e.at, NOW);
  assert.equal(e.kind, HISTORY_KIND.DROP);
  assert.equal(e.label.length, 120);
  assert.equal(e.campaign, "Sea of Thieves");
});

test("un type inconnu retombe sur drop", () => {
  assert.equal(makeEntry({ kind: "n'importe quoi" }, NOW).kind, HISTORY_KIND.DROP);
  assert.equal(makeEntry({ kind: HISTORY_KIND.POINTS }, NOW).kind, HISTORY_KIND.POINTS);
  assert.equal(makeEntry(null, NOW).label, "");
});

test("les plus récentes en tête, quel que soit l'ordre d'arrivée", () => {
  const journal = addEntries(
    [],
    [
      makeEntry({ id: "a", label: "vieux" }, NOW - 60_000),
      makeEntry({ id: "b", label: "récent" }, NOW),
    ],
  );
  assert.deepEqual(
    journal.map((e) => e.label),
    ["récent", "vieux"],
  );
});

test("RÉGRESSION : un relevé rejoué n'inscrit pas de doublon", () => {
  // Le comptage des drops relit l'inventaire à chaque passage : sans cette
  // garde, le journal grossirait d'une ligne identique toutes les 30 minutes.
  const un = addEntries([], [makeEntry({ id: "d1", label: "Coffre" }, NOW)]);
  const deux = addEntries(un, [makeEntry({ id: "d1", label: "Coffre" }, NOW + 1000)]);

  assert.equal(deux.length, 1);
  assert.equal(deux[0].at, NOW, "la première inscription fait foi");
});

test("les entrées sans identifiant s'accumulent, elles", () => {
  // Un bonus de points n'a pas d'identifiant stable : deux coffres se
  // ressemblent, et ce sont bien deux évènements distincts.
  let journal = addEntries([], [makeEntry({ kind: "points", channel: "zerator" }, NOW)]);
  journal = addEntries(journal, [makeEntry({ kind: "points", channel: "zerator" }, NOW + 60_000)]);
  assert.equal(journal.length, 2);
});

test("le journal est borné et garde les plus récentes", () => {
  const beaucoup = Array.from({ length: MAX_HISTORY + 30 }, (_, i) =>
    makeEntry({ id: `d${i}`, label: `drop ${i}` }, NOW + i),
  );
  const journal = addEntries([], beaucoup);

  assert.equal(journal.length, MAX_HISTORY);
  assert.equal(journal[0].label, `drop ${MAX_HISTORY + 29}`, "la plus récente est en tête");
});

test("rien à ajouter renvoie la liste d'origine", () => {
  const depart = [makeEntry({ id: "d1" }, NOW)];
  assert.equal(addEntries(depart, []), depart);
  assert.equal(addEntries(depart, null), depart);
  assert.deepEqual(addEntries(null, []), []);
});

test("countKind permet de recouper avec les compteurs", () => {
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
