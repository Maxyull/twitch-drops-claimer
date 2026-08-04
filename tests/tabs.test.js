import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_TAB,
  TABS,
  filterHistory,
  normalizeFilter,
  normalizeTab,
  tabForKey,
} from "../src/lib/tabs.js";

test("les flèches avancent et reculent", () => {
  assert.equal(tabForKey("live", "ArrowRight"), "history");
  assert.equal(tabForKey("history", "ArrowRight"), "campaigns");
  assert.equal(tabForKey("history", "ArrowLeft"), "live");
});

test("RÉGRESSION : les extrémités bouclent, elles ne bloquent pas", () => {
  // C'est le cas qu'on ne teste jamais à la main, et celui où une barre
  // d'onglets au clavier donne l'impression d'être cassée.
  assert.equal(tabForKey(TABS[TABS.length - 1], "ArrowRight"), TABS[0]);
  assert.equal(tabForKey(TABS[0], "ArrowLeft"), TABS[TABS.length - 1]);
});

test("Origine et Fin vont aux extrémités", () => {
  assert.equal(tabForKey("history", "Home"), "live");
  assert.equal(tabForKey("live", "End"), "campaigns");
});

test("une touche qui ne nous concerne pas est rendue au navigateur", () => {
  // Renvoyer un onglet sur Tab ou Entrée volerait des touches au reste de la
  // page, et empêcherait de sortir de la barre au clavier.
  for (const key of ["Tab", "Enter", " ", "Escape", "a"]) {
    assert.equal(tabForKey("live", key), null, key);
  }
});

test("un onglet courant inconnu ne fait rien", () => {
  assert.equal(tabForKey("inexistant", "ArrowRight"), null);
});

test("RÉGRESSION : une valeur venue du stockage n'est pas de confiance", () => {
  // `localStorage` se modifie à la main. Un onglet inconnu afficherait un
  // popup vide, sans aucun moyen d'en sortir.
  for (const sale of [null, undefined, "", "campaignsBox", 42, "__proto__", "constructor"]) {
    assert.equal(normalizeTab(sale), DEFAULT_TAB, String(sale));
  }
  assert.equal(normalizeTab("history"), "history");
});

test("le filtre du journal ne garde que le type demandé", () => {
  const journal = [
    { kind: "drop", at: 3 },
    { kind: "points", at: 2 },
    { kind: "drop", at: 1 },
  ];
  assert.equal(filterHistory(journal, "all").length, 3);
  assert.equal(filterHistory(journal, "drop").length, 2);
  assert.equal(filterHistory(journal, "points").length, 1);
});

test("RÉGRESSION : le filtre ne réordonne pas le journal", () => {
  // Le journal arrive trié du plus récent au plus ancien. Le filtre ne fait
  // que retirer, sinon la frise perdrait son sens.
  const journal = [
    { kind: "drop", at: 30 },
    { kind: "points", at: 20 },
    { kind: "drop", at: 10 },
  ];
  assert.deepEqual(
    filterHistory(journal, "all").map((e) => e.at),
    [30, 20, 10],
  );
  assert.deepEqual(
    filterHistory(journal, "drop").map((e) => e.at),
    [30, 10],
  );
});

test("un filtre inconnu montre tout plutôt que rien", () => {
  const journal = [{ kind: "drop", at: 1 }];
  assert.equal(normalizeFilter("nawak"), "all");
  assert.equal(filterHistory(journal, "nawak").length, 1);
});

test("un journal absent ou troué ne casse rien", () => {
  assert.deepEqual(filterHistory(null, "all"), []);
  assert.deepEqual(filterHistory(undefined, "drop"), []);
  assert.deepEqual(filterHistory([null, undefined], "all"), []);
});
