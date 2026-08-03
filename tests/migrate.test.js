// `migrate()` touche à l'API chrome : on la teste avec un faux stockage minimal,
// parce que c'est exactement la fonction qui peut effacer les réglages de
// l'utilisateur sans bruit (issue #3).

import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_SETTINGS } from "../src/lib/settings.js";

/** Faux `chrome.storage` suffisant pour storage.js. */
function fakeChrome(initialLocal = {}) {
  const local = { ...initialLocal };
  const session = {};

  const area = (bag) => ({
    async get(keys) {
      if (keys === null || keys === undefined) return { ...bag };
      if (typeof keys === "string") return keys in bag ? { [keys]: bag[keys] } : {};
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.filter((k) => k in bag).map((k) => [k, bag[k]]));
      }
      // objet de valeurs par défaut
      return Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, k in bag ? bag[k] : v]));
    },
    async set(values) {
      Object.assign(bag, values);
    },
    async remove(key) {
      delete bag[key];
    },
  });

  return { storage: { local: area(local), session: area(session) }, _local: local };
}

async function freshStorageModule() {
  // Le module lit `chrome` au moment de l'appel : un import par test suffit.
  return import(`../src/lib/storage.js?v=${Math.random()}`);
}

test("migrate conserve TOUS les réglages déjà valides", async () => {
  const existant = {
    enabled: false,
    claimPoints: false,
    favoriteChannels: ["zerator", "gotaga"],
    quality: "480p30",
    volumePercent: 42,
    claimIntervalMin: 7,
    discoverIntervalMin: 90,
    priority: "closestToDone",
    onlyLinkedCampaigns: true,
    notifyDrops: false,
    campaignBlacklist: ["camp-1"],
  };
  globalThis.chrome = fakeChrome(existant);
  const store = await freshStorageModule();

  await store.migrate();
  const settings = await store.getSettings();

  for (const [key, value] of Object.entries(existant)) {
    assert.deepEqual(settings[key], value, `${key} perdu par la migration`);
  }
});

test("migrate complète les manques par les valeurs par défaut", async () => {
  globalThis.chrome = fakeChrome({ favoriteChannels: ["zerator"] });
  const store = await freshStorageModule();

  await store.migrate();
  const settings = await store.getSettings();

  assert.deepEqual(settings.favoriteChannels, ["zerator"]);
  assert.equal(settings.quality, DEFAULT_SETTINGS.quality);
  assert.equal(settings.claimIntervalMin, DEFAULT_SETTINGS.claimIntervalMin);
});

test("migrate écrit la version et ne rejoue pas", async () => {
  const chrome = fakeChrome({ favoriteChannels: ["zerator"] });
  globalThis.chrome = chrome;
  const store = await freshStorageModule();

  assert.equal(await store.migrate(), store.STORAGE_VERSION);
  assert.equal(chrome._local.storageVersion, store.STORAGE_VERSION);

  // Un réglage postérieur à la migration ne doit pas être balayé par un second passage.
  await store.setSettings({ quality: "720p60" });
  await store.migrate();
  assert.equal((await store.getSettings()).quality, "720p60");
});

test("RÉGRESSION : deux rechargements d'affilée ne remettent rien à zéro", async () => {
  // Le vrai scénario de l'issue #3 : on recharge l'extension plusieurs fois.
  globalThis.chrome = fakeChrome({});
  const store = await freshStorageModule();

  await store.migrate();
  await store.setSettings({ favoriteChannels: ["mistermv"], volumePercent: 15 });

  for (let i = 0; i < 3; i += 1) await store.migrate();

  const settings = await store.getSettings();
  assert.deepEqual(settings.favoriteChannels, ["mistermv"]);
  assert.equal(settings.volumePercent, 15);
});

test("migrate garde les compteurs et les actions cochées", async () => {
  globalThis.chrome = fakeChrome({
    stats: { drops: 12, points: 148, lastClaim: 1, lastClaimLabel: "Coffre" },
    actions: [{ id: "link:camp-1", kind: "link", done: true }],
  });
  const store = await freshStorageModule();

  await store.migrate();
  assert.equal((await store.getStats()).drops, 12);
  assert.equal((await store.getActions())[0].done, true);
});
