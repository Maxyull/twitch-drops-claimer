// The extension's state is split across two storages, and that split is what
// decides what survives a reload. Three "extra window" reports had one common
// cause: a tab identity filed on the wrong side.

import test from "node:test";
import assert from "node:assert/strict";

/** A fake `chrome.storage` with two genuinely separate areas. */
function fakeChrome() {
  const zones = { local: {}, session: {} };

  const area = (bag) => ({
    async get(keys) {
      if (keys === null || keys === undefined) return { ...bag };
      if (typeof keys === "string") return keys in bag ? { [keys]: bag[keys] } : {};
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.filter((k) => k in bag).map((k) => [k, bag[k]]));
      }
      return Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, k in bag ? bag[k] : v]));
    },
    async set(values) {
      Object.assign(bag, values);
    },
    async remove(key) {
      delete bag[key];
    },
  });

  return {
    chrome: { storage: { local: area(zones.local), session: area(zones.session) } },
    zones,
  };
}

async function freshStore() {
  return import(`../src/lib/storage.js?v=${Math.random()}`);
}

test("REGRESSION: tab identity survives an extension reload", async () => {
  const { chrome, zones } = fakeChrome();
  globalThis.chrome = chrome;
  const store = await freshStore();

  await store.setState({
    windowId: 7,
    pointsTabId: 11,
    pointsChannel: "zerator",
    dropTabs: [{ tabId: 12, channel: "steelmage", campaignId: "c1", since: 1 }],
    inventoryTabId: 13,
  });

  // An extension reload clears `session`, never `local`.
  zones.session = {};
  globalThis.chrome.storage.session = fakeChrome().chrome.storage.session;

  const apres = await store.getState();
  assert.equal(apres.windowId, 7, "without the window, we create another one next to it");
  assert.equal(apres.pointsTabId, 11);
  assert.equal(apres.inventoryTabId, 13);
  assert.deepEqual(
    apres.dropTabs.map((e) => e.tabId),
    [12],
  );
});

test("what makes no sense to survive does not survive", async () => {
  const { chrome, zones } = fakeChrome();
  globalThis.chrome = chrome;
  const store = await freshStore();

  await store.recordBeat(11, { at: 1, channel: "zerator" });
  await store.setState({ rotationIndex: 3, proofCheckedAt: 42 });

  assert.equal((await store.getState()).rotationIndex, 3);

  globalThis.chrome.storage.session = fakeChrome().chrome.storage.session;
  zones.session = {};

  const apres = await store.getState();
  assert.deepEqual(apres.beats, {}, "a heartbeat from before the reload proves nothing");
  assert.equal(apres.rotationIndex, -1);
  assert.equal(apres.proofCheckedAt, 0);
});

test("a heartbeat does not touch on-disk storage", async () => {
  // Five seconds apart, two tabs: writing to disk at that rate for information
  // that is stale a second later is of no use whatsoever.
  const { chrome, zones } = fakeChrome();
  globalThis.chrome = chrome;
  const store = await freshStore();

  await store.setState({ windowId: 7 });
  const avant = JSON.stringify(zones.local);

  await store.recordBeat(11, { at: 1, channel: "zerator" });
  await store.recordBeat(12, { at: 2, channel: "gotaga" });

  assert.equal(JSON.stringify(zones.local), avant);
  assert.ok(zones.session.farmState.beats["11"], "the heartbeat did go to session");
});

test("forgetTab cleans both areas", async () => {
  const { chrome, zones } = fakeChrome();
  globalThis.chrome = chrome;
  const store = await freshStore();

  await store.setState({ pointsTabId: 11, pointsChannel: "zerator", tabChannels: { 11: "zerator" } });
  await store.recordBeat(11, { at: 1, channel: "zerator" });

  await store.forgetTab(11);
  const apres = await store.getState();

  assert.equal(apres.pointsTabId, null);
  assert.equal(apres.beats["11"], undefined);
  assert.equal(apres.tabChannels["11"], undefined);
  assert.equal(zones.local.tabState.pointsTabId, null, "and it really is written to disk");
});
