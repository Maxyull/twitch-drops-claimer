// `migrate()` touches the chrome API: it is tested against a minimal fake
// storage, because it is precisely the function that can wipe the user's settings
// without a sound (issue #3).

import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_SETTINGS } from "../src/lib/settings.js";

/** A fake `chrome.storage`, just enough for storage.js. */
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
      // object of default values
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

test("migrate keeps EVERY setting that is already valid", async () => {
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

test("migrate fills the gaps with the default values", async () => {
  globalThis.chrome = fakeChrome({ favoriteChannels: ["zerator"] });
  const store = await freshStorageModule();

  await store.migrate();
  const settings = await store.getSettings();

  assert.deepEqual(settings.favoriteChannels, ["zerator"]);
  assert.equal(settings.quality, DEFAULT_SETTINGS.quality);
  assert.equal(settings.claimIntervalMin, DEFAULT_SETTINGS.claimIntervalMin);
});

test("migrate writes the version and does not replay", async () => {
  const chrome = fakeChrome({ favoriteChannels: ["zerator"] });
  globalThis.chrome = chrome;
  const store = await freshStorageModule();

  assert.equal(await store.migrate(), store.STORAGE_VERSION);
  assert.equal(chrome._local.storageVersion, store.STORAGE_VERSION);

  // A setting written after the migration must not be swept away by a second pass.
  await store.setSettings({ quality: "720p60" });
  await store.migrate();
  assert.equal((await store.getSettings()).quality, "720p60");
});

test("REGRESSION: two reloads in a row reset nothing", async () => {
  // The real scenario from issue #3: the extension is reloaded several times.
  globalThis.chrome = fakeChrome({});
  const store = await freshStorageModule();

  await store.migrate();
  await store.setSettings({ favoriteChannels: ["mistermv"], volumePercent: 15 });

  for (let i = 0; i < 3; i += 1) await store.migrate();

  const settings = await store.getSettings();
  assert.deepEqual(settings.favoriteChannels, ["mistermv"]);
  assert.equal(settings.volumePercent, 15);
});

test("migrate keeps the counters and the ticked actions", async () => {
  globalThis.chrome = fakeChrome({
    stats: { drops: 12, points: 148, lastClaim: 1, lastClaimLabel: "Coffre" },
    actions: [{ id: "link:camp-1", kind: "link", done: true }],
  });
  const store = await freshStorageModule();

  await store.migrate();
  assert.equal((await store.getStats()).drops, 12);
  assert.equal((await store.getActions())[0].done, true);
});
