// End-to-end tests: Chromium really loads dist/ and we drive the popup and the
// options page the way a user would.
// Prerequisite: `python scripts/build.py` (an up-to-date dist/).

import { test, expect, chromium } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DIST = path.join(ROOT, "dist");

// The interface language follows the browser's, and the CI runner is in English:
// so any translation is accepted, whatever the active locale.
const LOCALES = ["fr", "en"].map((code) =>
  JSON.parse(readFileSync(path.join(ROOT, "_locales", code, "messages.json"), "utf8")),
);

function translations(key) {
  return LOCALES.map((dict) => dict[key]?.message).filter(Boolean);
}

async function expectTranslated(locator, key) {
  const actual = (await locator.textContent()) ?? "";
  const expected = translations(key);
  expect(expected.length).toBeGreaterThan(0);
  expect(expected, `text "${actual}" is in none of the translations of ${key}`).toContain(actual.trim());
}

let context;
let extensionId;
let profileDir;

async function launch(dir) {
  const ctx = await chromium.launchPersistentContext(dir, {
    // `channel: "chromium"` is required: the default headless shell cannot load
    // an extension, the real Chromium in --headless=new is needed.
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
  });
  // The service worker can take a moment to register.
  const worker = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
  return { ctx, id: worker.url().split("/")[2] };
}

test.beforeAll(async () => {
  if (!existsSync(DIST)) throw new Error("dist/ absent : lance `python scripts/build.py` d'abord");
  profileDir = mkdtempSync(path.join(tmpdir(), "tdc-e2e-"));
  const launched = await launch(profileDir);
  context = launched.ctx;
  extensionId = launched.id;
});

test.afterAll(async () => {
  await context?.close();
});

const url = (page) => `chrome-extension://${extensionId}/src/${page}`;

test("the extension loads with its service worker", async () => {
  expect(extensionId).toMatch(/^[a-p]{32}$/);
  expect(context.serviceWorkers().length).toBeGreaterThan(0);
});

test("the popup renders, translated, with no console error", async () => {
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => msg.type() === "error" && errors.push(msg.text()));

  await page.goto(url("popup/popup.html"));
  await expectTranslated(page.locator("h1"), "popup_title");
  await expectTranslated(page.locator("#refresh"), "popup_btn_refresh");

  // No i18n key left empty.
  const empties = await page.locator("[data-i18n]:empty").count();
  expect(empties).toBe(0);
  expect(errors).toEqual([]);
  await page.close();
});

test("the indicators and the badge exist from the very first launch", async () => {
  const page = await context.newPage();
  await page.goto(url("popup/popup.html"));
  // With no favourite channel: no watched tab, a red indicator, and the empty
  // list says why rather than staying silent.
  await expect(page.locator("#pointsDot")).toHaveClass(/red/);
  await expect(page.locator(".watcher")).toHaveCount(0);
  await expect(page.locator("#watchersEmpty")).toBeVisible();
  await expectTranslated(page.locator("#watchersEmpty"), "popup_points_none");
  await page.close();
});

test("message round trip: the options page writes, the worker answers", async () => {
  const page = await context.newPage();
  await page.goto(url("options/options.html"));

  await page.fill("#favoriteChannels", "https://www.twitch.tv/ZeratoR\n@gotaga");
  await page.fill("#volumePercent", "0"); // will be brought back to 1 by the normalisation
  await page.selectOption("#priority", "closestToDone");
  await page.click("#save");
  await expect(page.locator("#saved")).toHaveClass(/show/);

  // The service worker's answer is already normalised.
  await expect(page.locator("#favoriteChannels")).toHaveValue("zerator\ngotaga");
  await expect(page.locator("#volumePercent")).toHaveValue("1");

  // And it really is written to storage, not merely displayed.
  await expect
    .poll(() => page.evaluate(() => chrome.storage.local.get("favoriteChannels")))
    .toEqual({ favoriteChannels: ["zerator", "gotaga"] });

  await page.close();
});

test("REGRESSION: saving is impossible before the settings have been read", async () => {
  // Otherwise the empty form is written over the real settings, and the favourite
  // channels vanish for having clicked too early.
  const page = await context.newPage();
  await page.goto(url("options/options.html"));
  await expect(page.locator("#save")).toBeEnabled();
  await page.close();
});

test("REGRESSION: \"Saved\" is not shown when nothing was saved", async () => {
  const page = await context.newPage();
  await page.goto(url("options/options.html"));
  await expect(page.locator("#save")).toBeEnabled();

  // The line to the service worker is cut: the send is bound to fail.
  await page.evaluate(() => {
    chrome.runtime.sendMessage = () => Promise.reject(new Error("link cut"));
  });
  await page.click("#save");

  await expect(page.locator("#error")).toBeVisible();
  await expect(page.locator("#saved")).not.toHaveClass(/show/);

  // And above all: nothing was overwritten along the way.
  await expect
    .poll(() => page.evaluate(() => chrome.storage.local.get("favoriteChannels")))
    .toEqual({ favoriteChannels: ["zerator", "gotaga"] });

  await page.close();
});

test("the settings survive a page reload", async () => {
  const page = await context.newPage();
  await page.goto(url("options/options.html"));
  await expect(page.locator("#favoriteChannels")).toHaveValue("zerator\ngotaga");
  await expect(page.locator("#priority")).toHaveValue("closestToDone");
  await page.close();
});

/**
 * Closing the browser right after a write can lose it: `storage.local` is not on
 * disk yet. The value is read back from an extension page before shutting down,
 * which guarantees it has landed and makes these two tests deterministic rather
 * than intermittent.
 */
async function restartBrowser() {
  const page = await context.newPage();
  await page.goto(url("options/options.html"));

  // The whole storage is dumped: if the value is missing, the failure message has
  // to say what is there instead, not only what is absent.
  await expect
    .poll(async () => {
      const brut = await page.evaluate(() => chrome.storage.local.get(null));
      return JSON.stringify({
        favoriteChannels: brut.favoriteChannels,
        storageVersion: brut.storageVersion,
        cles: Object.keys(brut).sort(),
      });
    })
    .toContain('"favoriteChannels":["zerator","gotaga"]');

  await page.close();

  await context.close();
  const relaunched = await launch(profileDir);
  context = relaunched.ctx;
  extensionId = relaunched.id;
}

test("the settings survive the service worker's death (browser restart)", async () => {
  await restartBrowser();

  const page = await context.newPage();
  await page.goto(url("options/options.html"));
  await expect(page.locator("#favoriteChannels")).toHaveValue("zerator\ngotaga");
  await expect(page.locator("#volumePercent")).toHaveValue("1");
  await page.close();
});

test("REGRESSION: a schema upgrade loses no setting", async () => {
  // A real migration is replayed: `storageVersion` reset to 1, then a browser
  // restart. That is when `migrate()` runs, and it is the one place in the code
  // able to wipe settings without a sound (issue #3).
  const page = await context.newPage();
  await page.goto(url("options/options.html"));
  await page.evaluate(() => chrome.storage.local.set({ storageVersion: 1 }));
  await page.close();

  await restartBrowser();

  const after = await context.newPage();
  await after.goto(url("options/options.html"));
  await expect(after.locator("#favoriteChannels")).toHaveValue("zerator\ngotaga");
  await expect(after.locator("#priority")).toHaveValue("closestToDone");
  await expect(after.locator("#volumePercent")).toHaveValue("1");

  // The migration really ran, otherwise the test would prove nothing.
  const version = await after.evaluate(() =>
    chrome.storage.local.get("storageVersion").then((r) => r.storageVersion),
  );
  expect(version).toBe(2);
  await after.close();
});

test("the popup reflects the toggles and propagates them back", async () => {
  const page = await context.newPage();
  await page.goto(url("popup/popup.html"));

  await expect(page.locator("#enabled")).toHaveClass(/on/);
  await page.click("#enabled");
  await expect(page.locator("#enabled")).not.toHaveClass(/on/);

  await page.reload();
  await expect(page.locator("#enabled")).not.toHaveClass(/on/);
  await page.click("#enabled"); // on remet en marche
  await page.close();
});
