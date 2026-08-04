import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SETTINGS,
  normalizeChannel,
  normalizeChannelList,
  normalizeSettings,
} from "../src/lib/settings.js";

test("normalizeChannel accepte pseudo, arobase et URL", () => {
  assert.equal(normalizeChannel("ZeratoR"), "zerator");
  assert.equal(normalizeChannel("  @Gotaga "), "gotaga");
  assert.equal(normalizeChannel("https://www.twitch.tv/Kamet0?tt_medium=x"), "kamet0");
  assert.equal(normalizeChannel("twitch.tv/domingo/videos"), "domingo");
});

test("normalizeChannel rejects anything that is not a login", () => {
  assert.equal(normalizeChannel(""), "");
  assert.equal(normalizeChannel("   "), "");
  assert.equal(normalizeChannel("a nickname with spaces"), "");
  assert.equal(normalizeChannel("é!!"), "");
  assert.equal(normalizeChannel(null), "");
  assert.equal(normalizeChannel(42), "");
});

test("normalizeChannelList deduplicates and accepts multiline text", () => {
  const list = normalizeChannelList("ZeratoR\n@zerator\nhttps://twitch.tv/gotaga\n\n , mistermv");
  assert.deepEqual(list, ["zerator", "gotaga", "mistermv"]);
});

test("normalizeChannelList caps at 20 channels", () => {
  const many = Array.from({ length: 40 }, (_, i) => `chaine${i}`);
  assert.equal(normalizeChannelList(many).length, 20);
});

test("normalizeSettings fills the gaps with the default values", () => {
  const s = normalizeSettings({});
  assert.deepEqual(s, { ...DEFAULT_SETTINGS, favoriteChannels: [] });
});

test("normalizeSettings bounds the intervals and the volume", () => {
  const s = normalizeSettings({
    claimIntervalMin: 0,
    discoverIntervalMin: 9999,
    volumePercent: 0,
  });
  assert.equal(s.claimIntervalMin, 1);
  assert.equal(s.discoverIntervalMin, 240);
  assert.equal(s.volumePercent, 1);
});

test("the number of farming tabs stays within useful bounds", () => {
  // 0 tabs would amount to turning farming off, which `farmDrops` already does.
  // Beyond 4 we would open tabs Twitch is not going to count.
  assert.equal(normalizeSettings({ farmTabs: 0 }).farmTabs, 1);
  assert.equal(normalizeSettings({ farmTabs: 99 }).farmTabs, 4);
  assert.equal(normalizeSettings({ farmTabs: 2 }).farmTabs, 2);
  assert.equal(normalizeSettings({ farmTabs: "trois" }).farmTabs, DEFAULT_SETTINGS.farmTabs);
});

test("0 turns the rotation off, without turning the other loops off", () => {
  // Seul `rotateIntervalMin` accepte 0 : ailleurs, 0 voudrait dire « en boucle
  // endlessly", which is not an intention anyone can express.
  assert.equal(normalizeSettings({ rotateIntervalMin: 0 }).rotateIntervalMin, 0);
  assert.equal(normalizeSettings({ rotateIntervalMin: -5 }).rotateIntervalMin, 0);
  assert.equal(normalizeSettings({ rotateIntervalMin: 9999 }).rotateIntervalMin, 240);
  assert.equal(normalizeSettings({ claimIntervalMin: 0 }).claimIntervalMin, 1);
  assert.equal(normalizeSettings({ discoverIntervalMin: 0 }).discoverIntervalMin, 1);
});

test("normalizeSettings refuses an unknown quality or priority", () => {
  const s = normalizeSettings({ quality: "8k", priority: "n'importe quoi" });
  assert.equal(s.quality, DEFAULT_SETTINGS.quality);
  assert.equal(s.priority, DEFAULT_SETTINGS.priority);
});

test("normalizeSettings keeps booleans that are explicitly false", () => {
  const s = normalizeSettings({ enabled: false, claimPoints: false, notifyDrops: false });
  assert.equal(s.enabled, false);
  assert.equal(s.claimPoints, false);
  assert.equal(s.notifyDrops, false);
});

test("normalizeSettings ignores a non-boolean value", () => {
  const s = normalizeSettings({ enabled: "oui" });
  assert.equal(s.enabled, true);
});
