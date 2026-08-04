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

test("the arrows move forward and back", () => {
  assert.equal(tabForKey("live", "ArrowRight"), "history");
  assert.equal(tabForKey("history", "ArrowRight"), "campaigns");
  assert.equal(tabForKey("history", "ArrowLeft"), "live");
});

test("REGRESSION: the ends wrap around, they do not block", () => {
  // This is the case nobody ever tests by hand, and the one where a keyboard-
  // driven tab bar feels broken.
  assert.equal(tabForKey(TABS[TABS.length - 1], "ArrowRight"), TABS[0]);
  assert.equal(tabForKey(TABS[0], "ArrowLeft"), TABS[TABS.length - 1]);
});

test("Home and End go to the ends", () => {
  assert.equal(tabForKey("history", "Home"), "live");
  assert.equal(tabForKey("live", "End"), "campaigns");
});

test("a key that is none of our business is handed back to the browser", () => {
  // Returning a tab on Tab or Enter would steal keys from the rest of the page,
  // and would make it impossible to leave the bar with the keyboard.
  for (const key of ["Tab", "Enter", " ", "Escape", "a"]) {
    assert.equal(tabForKey("live", key), null, key);
  }
});

test("an unknown current tab does nothing", () => {
  assert.equal(tabForKey("inexistant", "ArrowRight"), null);
});

test("REGRESSION: a value coming from storage is not trusted", () => {
  // `localStorage` can be edited by hand. An unknown tab would render an empty
  // popup, with no way out of it.
  for (const sale of [null, undefined, "", "campaignsBox", 42, "__proto__", "constructor"]) {
    assert.equal(normalizeTab(sale), DEFAULT_TAB, String(sale));
  }
  assert.equal(normalizeTab("history"), "history");
});

test("the log filter keeps only the requested kind", () => {
  const journal = [
    { kind: "drop", at: 3 },
    { kind: "points", at: 2 },
    { kind: "drop", at: 1 },
  ];
  assert.equal(filterHistory(journal, "all").length, 3);
  assert.equal(filterHistory(journal, "drop").length, 2);
  assert.equal(filterHistory(journal, "points").length, 1);
});

test("REGRESSION: the filter does not reorder the log", () => {
  // The log arrives sorted newest to oldest. The filter only removes, otherwise
  // the timeline would lose its meaning.
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

test("an unknown filter shows everything rather than nothing", () => {
  const journal = [{ kind: "drop", at: 1 }];
  assert.equal(normalizeFilter("nawak"), "all");
  assert.equal(filterHistory(journal, "nawak").length, 1);
});

test("a missing or holed log breaks nothing", () => {
  assert.deepEqual(filterHistory(null, "all"), []);
  assert.deepEqual(filterHistory(undefined, "drop"), []);
  assert.deepEqual(filterHistory([null, undefined], "all"), []);
});
