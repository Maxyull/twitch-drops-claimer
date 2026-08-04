import test from "node:test";
import assert from "node:assert/strict";

import { validateMessage, isTwitchUrl, isExtensionUrl } from "../src/lib/message-guard.js";
import { MSG, CLAIM_KIND } from "../src/lib/messaging.js";

const EXT_ID = "abcdefghijklmnopabcdefghijklmnop";
const fromTab = { id: EXT_ID, tab: { id: 7 }, url: "https://www.twitch.tv/zerator" };
const fromPopup = { id: EXT_ID, url: `chrome-extension://${EXT_ID}/src/popup/popup.html` };
// The options page opens in a tab: it therefore has a `sender.tab`.
//
// The French `error` strings matched below belong to src/lib/message-guard.js and
// stay: they reach the popup, so they are user-visible and move with #76.
const fromOptions = {
  id: EXT_ID,
  tab: { id: 12 },
  url: `chrome-extension://${EXT_ID}/src/options/options.html`,
};

test("a sender from another extension is rejected", () => {
  const res = validateMessage({ type: MSG.BEAT }, { id: "autre-extension", tab: { id: 1 } }, EXT_ID);
  assert.equal(res.ok, false);
  assert.match(res.error, /expéditeur/);
});

test("an unknown message type is rejected (no dynamic dispatch)", () => {
  for (const type of ["", "constructor", "__proto__", "toString", "n-importe-quoi", 42]) {
    assert.equal(validateMessage({ type }, fromPopup, EXT_ID).ok, false, `type accepted: ${type}`);
  }
  assert.equal(validateMessage(null, fromPopup, EXT_ID).ok, false);
});

test("REGRESSION: a web page cannot drive the extension", () => {
  // The critical point: if Twitch were compromised, its content script must not
  // be able to change the settings or read the full state.
  for (const type of [MSG.SET_SETTINGS, MSG.GET_STATE, MSG.REFRESH_NOW, MSG.SET_CAMPAIGN_PRIORITY]) {
    const res = validateMessage({ type, payload: { enabled: false } }, fromTab, EXT_ID);
    assert.equal(res.ok, false, `${type} accepted from a tab`);
  }
});

test("a tab message coming from anywhere but Twitch is rejected", () => {
  const res = validateMessage(
    { type: MSG.BEAT, payload: {} },
    { id: EXT_ID, tab: { id: 3 }, url: "https://evil.example/x" },
    EXT_ID,
  );
  assert.equal(res.ok, false);
});

test("a content message sent from the popup is rejected", () => {
  assert.equal(validateMessage({ type: MSG.BEAT, payload: {} }, fromPopup, EXT_ID).ok, false);
});

test("REGRESSION: the options page is a tab and must be accepted", () => {
  // The first attempt decided on `sender.tab` being present, which rejected the
  // options page: its saves went silently into the bin.
  for (const type of [MSG.GET_STATE, MSG.REFRESH_NOW]) {
    assert.equal(validateMessage({ type }, fromOptions, EXT_ID).ok, true, `${type} rejected`);
  }
  const res = validateMessage(
    { type: MSG.SET_SETTINGS, payload: { enabled: false } },
    fromOptions,
    EXT_ID,
  );
  assert.equal(res.ok, true);
});

test("an extension page with another id is rejected", () => {
  const usurpateur = {
    id: EXT_ID,
    tab: { id: 3 },
    url: "chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz/src/options/options.html",
  };
  assert.equal(validateMessage({ type: MSG.GET_STATE }, usurpateur, EXT_ID).ok, false);
});

test("isExtensionUrl only recognises our own pages", () => {
  assert.equal(isExtensionUrl(`chrome-extension://${EXT_ID}/src/popup/popup.html`, EXT_ID), true);
  assert.equal(isExtensionUrl("chrome-extension://autre/src/popup/popup.html", EXT_ID), false);
  assert.equal(isExtensionUrl("https://www.twitch.tv/", EXT_ID), false);
  assert.equal(isExtensionUrl(undefined, EXT_ID), false);
  assert.equal(isExtensionUrl(`chrome-extension://${EXT_ID}/x`, ""), false);
});

test("the heartbeat is bounded and cleaned", () => {
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
  assert.equal(res.payload.videoHeight, 10_000, "bounded");
  assert.equal(res.payload.paused, false, "seul true vaut true");
  assert.equal(res.payload.ads, false);
  assert.equal(res.payload.offline, true);
  assert.equal(res.payload.url.length, 500, "truncated");
  assert.equal("extra" in res.payload, false, "unknown field dropped");
});

test("a claim keeps a known kind and bounded texts", () => {
  const res = validateMessage(
    { type: MSG.CLAIMED, payload: { kind: "n'importe quoi", label: "L".repeat(500) } },
    fromTab,
    EXT_ID,
  );
  assert.equal(res.ok, true);
  assert.equal(res.payload.kind, CLAIM_KIND.DROP, "unknown kind brought back to drop");
  assert.equal(res.payload.label.length, 120);

  const points = validateMessage(
    { type: MSG.CLAIMED, payload: { kind: CLAIM_KIND.POINTS, channel: "gotaga" } },
    fromTab,
    EXT_ID,
  );
  assert.equal(points.payload.kind, CLAIM_KIND.POINTS);
  assert.equal(points.payload.channel, "gotaga");
});

test("REGRESSION: setSettings only accepts known keys", () => {
  const res = validateMessage(
    {
      type: MSG.SET_SETTINGS,
      payload: { enabled: false, __proto__: { polluted: true }, password: "x", quality: "160p30" },
    },
    fromPopup,
    EXT_ID,
  );
  assert.equal(res.ok, true);
  assert.deepEqual(Object.keys(res.payload).sort(), ["enabled", "quality"]);
});

test("setSettings with no known key at all is refused", () => {
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
  assert.equal(res.payload.done, true, "ticked by default");
});

test("a campaign's priority only accepts three values", () => {
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
    assert.equal(res.ok, false, `value wrongly accepted: ${priority}`);
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

test("messages with no payload get through", () => {
  for (const type of [MSG.GET_STATE, MSG.REFRESH_NOW, MSG.SWITCH_NOW]) {
    assert.equal(validateMessage({ type }, fromPopup, EXT_ID).ok, true);
  }
});

test("isTwitchUrl only accepts the exact domain over HTTPS", () => {
  assert.equal(isTwitchUrl("https://www.twitch.tv/zerator"), true);
  assert.equal(isTwitchUrl("http://www.twitch.tv/zerator"), false);
  assert.equal(isTwitchUrl("https://twitch.tv.evil.example/"), false);
  assert.equal(isTwitchUrl("https://m.twitch.tv/"), false);
  assert.equal(isTwitchUrl("not a url"), false);
  assert.equal(isTwitchUrl(undefined), false);
});
