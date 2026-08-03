// L'état de l'extension est réparti entre deux stockages, et c'est ce partage
// qui décide de ce qui survit à un rechargement. Trois fenêtres en trop ont eu
// pour cause commune une identité d'onglet rangée du mauvais côté.

import test from "node:test";
import assert from "node:assert/strict";

/** Faux `chrome.storage` avec deux zones réellement distinctes. */
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

test("RÉGRESSION : l'identité des onglets survit à un rechargement de l'extension", async () => {
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

  // Un rechargement de l'extension vide `session`, jamais `local`.
  zones.session = {};
  globalThis.chrome.storage.session = fakeChrome().chrome.storage.session;

  const apres = await store.getState();
  assert.equal(apres.windowId, 7, "sans la fenêtre, on en recrée une à côté");
  assert.equal(apres.pointsTabId, 11);
  assert.equal(apres.inventoryTabId, 13);
  assert.deepEqual(
    apres.dropTabs.map((e) => e.tabId),
    [12],
  );
});

test("ce qui n'a aucun sens de survivre ne survit pas", async () => {
  const { chrome, zones } = fakeChrome();
  globalThis.chrome = chrome;
  const store = await freshStore();

  await store.recordBeat(11, { at: 1, channel: "zerator" });
  await store.setState({ rotationIndex: 3, proofCheckedAt: 42 });

  assert.equal((await store.getState()).rotationIndex, 3);

  globalThis.chrome.storage.session = fakeChrome().chrome.storage.session;
  zones.session = {};

  const apres = await store.getState();
  assert.deepEqual(apres.beats, {}, "un battement d'avant le rechargement ne prouve rien");
  assert.equal(apres.rotationIndex, -1);
  assert.equal(apres.proofCheckedAt, 0);
});

test("un battement ne touche pas le stockage sur disque", async () => {
  // Cinq secondes d'intervalle, deux onglets : écrire sur disque à ce rythme
  // pour une information périmée à la seconde suivante n'a aucun intérêt.
  const { chrome, zones } = fakeChrome();
  globalThis.chrome = chrome;
  const store = await freshStore();

  await store.setState({ windowId: 7 });
  const avant = JSON.stringify(zones.local);

  await store.recordBeat(11, { at: 1, channel: "zerator" });
  await store.recordBeat(12, { at: 2, channel: "gotaga" });

  assert.equal(JSON.stringify(zones.local), avant);
  assert.ok(zones.session.farmState.beats["11"], "le battement est bien allé en session");
});

test("forgetTab nettoie les deux zones", async () => {
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
  assert.equal(zones.local.tabState.pointsTabId, null, "et c'est bien écrit sur disque");
});
