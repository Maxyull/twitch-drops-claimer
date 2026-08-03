// Tests de bout en bout : Chromium charge réellement dist/ et on pilote
// le popup et la page d'options comme un utilisateur.
// Prérequis : `python scripts/build.py` (dist/ à jour).

import { test, expect, chromium } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DIST = path.join(ROOT, "dist");

// La langue de l'interface suit celle du navigateur, et le runner de la CI est en
// anglais : on accepte donc la traduction, quelle que soit la locale active.
const LOCALES = ["fr", "en"].map((code) =>
  JSON.parse(readFileSync(path.join(ROOT, "_locales", code, "messages.json"), "utf8")),
);

function translations(key) {
  return LOCALES.map((dict) => dict[key]?.message).filter(Boolean);
}

async function expectTranslated(locator, key) {
  const actual = await locator.textContent();
  const expected = translations(key);
  expect(expected.length).toBeGreaterThan(0);
  expect(expected, `texte "${actual}" absent des traductions de ${key}`).toContain(actual.trim());
}

let context;
let extensionId;
let profileDir;

async function launch(dir) {
  const ctx = await chromium.launchPersistentContext(dir, {
    // `channel: "chromium"` est obligatoire : le « headless shell » par défaut
    // ne sait pas charger d'extension, il faut le vrai Chromium en --headless=new.
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
  });
  // Le service worker peut mettre un instant à s'enregistrer.
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

test("l'extension se charge avec son service worker", async () => {
  expect(extensionId).toMatch(/^[a-p]{32}$/);
  expect(context.serviceWorkers().length).toBeGreaterThan(0);
});

test("le popup s'affiche, traduit, sans erreur console", async () => {
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => msg.type() === "error" && errors.push(msg.text()));

  await page.goto(url("popup/popup.html"));
  await expectTranslated(page.locator("h1"), "popup_title");
  await expectTranslated(page.locator("#refresh"), "popup_btn_refresh");

  // Aucune clé i18n laissée vide.
  const empties = await page.locator("[data-i18n]:empty").count();
  expect(empties).toBe(0);
  expect(errors).toEqual([]);
  await page.close();
});

test("les voyants et le badge existent dès le premier lancement", async () => {
  const page = await context.newPage();
  await page.goto(url("popup/popup.html"));
  // Sans chaîne favorite, le voyant des points doit être rouge et le dire.
  await expect(page.locator("#pointsDot")).toHaveClass(/red/);
  await expectTranslated(page.locator("#pointsInfo"), "popup_points_none");
  await page.close();
});

test("aller-retour de messages : la page d'options écrit, le worker répond", async () => {
  const page = await context.newPage();
  await page.goto(url("options/options.html"));

  await page.fill("#favoriteChannels", "https://www.twitch.tv/ZeratoR\n@gotaga");
  await page.fill("#volumePercent", "0"); // sera ramené à 1 par la normalisation
  await page.selectOption("#priority", "closestToDone");
  await page.click("#save");
  await expect(page.locator("#saved")).toHaveClass(/show/);

  // La réponse du service worker est déjà normalisée.
  await expect(page.locator("#favoriteChannels")).toHaveValue("zerator\ngotaga");
  await expect(page.locator("#volumePercent")).toHaveValue("1");
  await page.close();
});

test("RÉGRESSION : « Enregistré » ne s'affiche pas si rien n'est enregistré", async () => {
  const page = await context.newPage();
  await page.goto(url("options/options.html"));

  // On coupe la ligne avec le service worker : l'envoi échouera forcément.
  await page.evaluate(() => {
    chrome.runtime.sendMessage = () => Promise.reject(new Error("lien coupé"));
  });
  await page.click("#save");

  await expect(page.locator("#error")).toBeVisible();
  await expect(page.locator("#saved")).not.toHaveClass(/show/);
  await page.close();
});

test("les réglages survivent au rechargement de la page", async () => {
  const page = await context.newPage();
  await page.goto(url("options/options.html"));
  await expect(page.locator("#favoriteChannels")).toHaveValue("zerator\ngotaga");
  await expect(page.locator("#priority")).toHaveValue("closestToDone");
  await page.close();
});

test("les réglages survivent à la mort du service worker (redémarrage du navigateur)", async () => {
  await context.close();
  const relaunched = await launch(profileDir);
  context = relaunched.ctx;
  extensionId = relaunched.id;

  const page = await context.newPage();
  await page.goto(url("options/options.html"));
  await expect(page.locator("#favoriteChannels")).toHaveValue("zerator\ngotaga");
  await expect(page.locator("#volumePercent")).toHaveValue("1");
  await page.close();
});

test("RÉGRESSION : une montée de schéma ne perd aucun réglage", async () => {
  // On rejoue une vraie migration : `storageVersion` remis à 1, puis redémarrage
  // du navigateur. C'est le moment où `migrate()` tourne, et le seul endroit du
  // code capable d'effacer des réglages sans bruit (issue #3).
  const page = await context.newPage();
  await page.goto(url("options/options.html"));
  await page.evaluate(() => chrome.storage.local.set({ storageVersion: 1 }));
  await page.close();

  await context.close();
  const relaunched = await launch(profileDir);
  context = relaunched.ctx;
  extensionId = relaunched.id;

  const after = await context.newPage();
  await after.goto(url("options/options.html"));
  await expect(after.locator("#favoriteChannels")).toHaveValue("zerator\ngotaga");
  await expect(after.locator("#priority")).toHaveValue("closestToDone");
  await expect(after.locator("#volumePercent")).toHaveValue("1");

  // La migration a bien tourné, sinon le test ne prouverait rien.
  const version = await after.evaluate(() =>
    chrome.storage.local.get("storageVersion").then((r) => r.storageVersion),
  );
  expect(version).toBe(2);
  await after.close();
});

test("le popup reflète les bascules et les repropage", async () => {
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
