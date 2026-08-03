import test from "node:test";
import assert from "node:assert/strict";

import { validateMessage, isTwitchUrl, isExtensionUrl } from "../src/lib/message-guard.js";
import { MSG, CLAIM_KIND } from "../src/lib/messaging.js";

const EXT_ID = "abcdefghijklmnopabcdefghijklmnop";
const fromTab = { id: EXT_ID, tab: { id: 7 }, url: "https://www.twitch.tv/zerator" };
const fromPopup = { id: EXT_ID, url: `chrome-extension://${EXT_ID}/src/popup/popup.html` };
// La page d'options s'ouvre dans un onglet : elle a donc un `sender.tab`.
const fromOptions = {
  id: EXT_ID,
  tab: { id: 12 },
  url: `chrome-extension://${EXT_ID}/src/options/options.html`,
};

test("un expéditeur d'une autre extension est rejeté", () => {
  const res = validateMessage({ type: MSG.BEAT }, { id: "autre-extension", tab: { id: 1 } }, EXT_ID);
  assert.equal(res.ok, false);
  assert.match(res.error, /expéditeur/);
});

test("un type de message inconnu est rejeté (pas de dispatch dynamique)", () => {
  for (const type of ["", "constructor", "__proto__", "toString", "n-importe-quoi", 42]) {
    assert.equal(validateMessage({ type }, fromPopup, EXT_ID).ok, false, `type accepté : ${type}`);
  }
  assert.equal(validateMessage(null, fromPopup, EXT_ID).ok, false);
});

test("RÉGRESSION : une page web ne peut pas piloter l'extension", () => {
  // Le point critique : si Twitch était compromis, son script de contenu ne doit
  // pas pouvoir changer les réglages ni lire l'état complet.
  for (const type of [MSG.SET_SETTINGS, MSG.GET_STATE, MSG.REFRESH_NOW, MSG.SET_CAMPAIGN_PRIORITY]) {
    const res = validateMessage({ type, payload: { enabled: false } }, fromTab, EXT_ID);
    assert.equal(res.ok, false, `${type} accepté depuis un onglet`);
  }
});

test("un message d'onglet venu d'ailleurs que Twitch est rejeté", () => {
  const res = validateMessage(
    { type: MSG.BEAT, payload: {} },
    { id: EXT_ID, tab: { id: 3 }, url: "https://evil.example/x" },
    EXT_ID,
  );
  assert.equal(res.ok, false);
});

test("un message de contenu envoyé depuis le popup est rejeté", () => {
  assert.equal(validateMessage({ type: MSG.BEAT, payload: {} }, fromPopup, EXT_ID).ok, false);
});

test("RÉGRESSION : la page d'options est un onglet et doit être acceptée", () => {
  // Le premier jet tranchait sur la présence de `sender.tab`, ce qui rejetait la
  // page d'options : ses enregistrements partaient à la poubelle en silence.
  for (const type of [MSG.GET_STATE, MSG.REFRESH_NOW]) {
    assert.equal(validateMessage({ type }, fromOptions, EXT_ID).ok, true, `${type} rejeté`);
  }
  const res = validateMessage(
    { type: MSG.SET_SETTINGS, payload: { enabled: false } },
    fromOptions,
    EXT_ID,
  );
  assert.equal(res.ok, true);
});

test("une page d'extension d'un autre identifiant est rejetée", () => {
  const usurpateur = {
    id: EXT_ID,
    tab: { id: 3 },
    url: "chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz/src/options/options.html",
  };
  assert.equal(validateMessage({ type: MSG.GET_STATE }, usurpateur, EXT_ID).ok, false);
});

test("isExtensionUrl ne reconnaît que nos propres pages", () => {
  assert.equal(isExtensionUrl(`chrome-extension://${EXT_ID}/src/popup/popup.html`, EXT_ID), true);
  assert.equal(isExtensionUrl("chrome-extension://autre/src/popup/popup.html", EXT_ID), false);
  assert.equal(isExtensionUrl("https://www.twitch.tv/", EXT_ID), false);
  assert.equal(isExtensionUrl(undefined, EXT_ID), false);
  assert.equal(isExtensionUrl(`chrome-extension://${EXT_ID}/x`, ""), false);
});

test("le battement est borné et nettoyé", () => {
  const res = validateMessage(
    {
      type: MSG.BEAT,
      payload: {
        channel: "https://www.twitch.tv/ZeratoR",
        currentTime: "12.5",
        videoHeight: 999_999,
        paused: "oui",
        ads: 1,
        offline: true,
        url: "x".repeat(9000),
        extra: "champ pirate",
      },
    },
    fromTab,
    EXT_ID,
  );

  assert.equal(res.ok, true);
  assert.equal(res.payload.channel, "zerator");
  assert.equal(res.payload.currentTime, 12.5);
  assert.equal(res.payload.videoHeight, 10_000, "borné");
  assert.equal(res.payload.paused, false, "seul true vaut true");
  assert.equal(res.payload.ads, false);
  assert.equal(res.payload.offline, true);
  assert.equal(res.payload.url.length, 500, "tronqué");
  assert.equal("extra" in res.payload, false, "champ inconnu jeté");
});

test("une réclamation garde un type connu et des textes bornés", () => {
  const res = validateMessage(
    { type: MSG.CLAIMED, payload: { kind: "n'importe quoi", label: "L".repeat(500) } },
    fromTab,
    EXT_ID,
  );
  assert.equal(res.ok, true);
  assert.equal(res.payload.kind, CLAIM_KIND.DROP, "type inconnu ramené à drop");
  assert.equal(res.payload.label.length, 120);

  const points = validateMessage(
    { type: MSG.CLAIMED, payload: { kind: CLAIM_KIND.POINTS, channel: "gotaga" } },
    fromTab,
    EXT_ID,
  );
  assert.equal(points.payload.kind, CLAIM_KIND.POINTS);
  assert.equal(points.payload.channel, "gotaga");
});

test("RÉGRESSION : setSettings n'accepte que les clés connues", () => {
  const res = validateMessage(
    {
      type: MSG.SET_SETTINGS,
      payload: { enabled: false, __proto__: { pollué: true }, motDePasse: "x", quality: "160p30" },
    },
    fromPopup,
    EXT_ID,
  );
  assert.equal(res.ok, true);
  assert.deepEqual(Object.keys(res.payload).sort(), ["enabled", "quality"]);
});

test("setSettings sans aucune clé connue est refusé", () => {
  assert.equal(
    validateMessage({ type: MSG.SET_SETTINGS, payload: { hop: 1 } }, fromPopup, EXT_ID).ok,
    false,
  );
  assert.equal(validateMessage({ type: MSG.SET_SETTINGS, payload: "texte" }, fromPopup, EXT_ID).ok, false);
});

test("setActionDone exige un identifiant", () => {
  assert.equal(validateMessage({ type: MSG.SET_ACTION_DONE, payload: {} }, fromPopup, EXT_ID).ok, false);
  const res = validateMessage(
    { type: MSG.SET_ACTION_DONE, payload: { id: "link:camp-1" } },
    fromPopup,
    EXT_ID,
  );
  assert.equal(res.ok, true);
  assert.equal(res.payload.done, true, "par défaut on coche");
});

test("la priorité d'une campagne n'accepte que trois valeurs", () => {
  const ok = validateMessage(
    { type: MSG.SET_CAMPAIGN_PRIORITY, payload: { id: "camp-1", priority: "focus" } },
    fromOptions,
    EXT_ID,
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.payload.priority, "focus");

  for (const priority of ["FOCUS", "toutes", "", null, 1]) {
    const res = validateMessage(
      { type: MSG.SET_CAMPAIGN_PRIORITY, payload: { id: "camp-1", priority } },
      fromOptions,
      EXT_ID,
    );
    assert.equal(res.ok, false, `valeur acceptée à tort : ${priority}`);
  }

  assert.equal(
    validateMessage(
      { type: MSG.SET_CAMPAIGN_PRIORITY, payload: { priority: "focus" } },
      fromOptions,
      EXT_ID,
    ).ok,
    false,
    "identifiant obligatoire",
  );
});

test("les messages sans charge utile passent", () => {
  for (const type of [MSG.GET_STATE, MSG.REFRESH_NOW, MSG.SWITCH_NOW]) {
    assert.equal(validateMessage({ type }, fromPopup, EXT_ID).ok, true);
  }
});

test("isTwitchUrl n'accepte que le domaine exact en HTTPS", () => {
  assert.equal(isTwitchUrl("https://www.twitch.tv/zerator"), true);
  assert.equal(isTwitchUrl("http://www.twitch.tv/zerator"), false);
  assert.equal(isTwitchUrl("https://twitch.tv.evil.example/"), false);
  assert.equal(isTwitchUrl("https://m.twitch.tv/"), false);
  assert.equal(isTwitchUrl("pas une url"), false);
  assert.equal(isTwitchUrl(undefined), false);
});
