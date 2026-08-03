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

test("normalizeChannel rejette ce qui n'est pas un login", () => {
  assert.equal(normalizeChannel(""), "");
  assert.equal(normalizeChannel("   "), "");
  assert.equal(normalizeChannel("un pseudo avec espaces"), "");
  assert.equal(normalizeChannel("é!!"), "");
  assert.equal(normalizeChannel(null), "");
  assert.equal(normalizeChannel(42), "");
});

test("normalizeChannelList déduplique et accepte le texte multiligne", () => {
  const list = normalizeChannelList("ZeratoR\n@zerator\nhttps://twitch.tv/gotaga\n\n , mistermv");
  assert.deepEqual(list, ["zerator", "gotaga", "mistermv"]);
});

test("normalizeChannelList plafonne à 20 chaînes", () => {
  const many = Array.from({ length: 40 }, (_, i) => `chaine${i}`);
  assert.equal(normalizeChannelList(many).length, 20);
});

test("normalizeSettings complète les manques par les valeurs par défaut", () => {
  const s = normalizeSettings({});
  assert.deepEqual(s, { ...DEFAULT_SETTINGS, favoriteChannels: [] });
});

test("normalizeSettings borne les intervalles et le volume", () => {
  const s = normalizeSettings({
    claimIntervalMin: 0,
    discoverIntervalMin: 9999,
    volumePercent: 0,
  });
  assert.equal(s.claimIntervalMin, 1);
  assert.equal(s.discoverIntervalMin, 240);
  // Régression : un volume à 0 ferait brider l'onglet caché par Chrome.
  assert.equal(s.volumePercent, 1);
});

test("normalizeSettings refuse une qualité ou une priorité inconnue", () => {
  const s = normalizeSettings({ quality: "8k", priority: "n'importe quoi" });
  assert.equal(s.quality, DEFAULT_SETTINGS.quality);
  assert.equal(s.priority, DEFAULT_SETTINGS.priority);
});

test("normalizeSettings garde les booléens explicitement à false", () => {
  const s = normalizeSettings({ enabled: false, claimPoints: false, notifyDrops: false });
  assert.equal(s.enabled, false);
  assert.equal(s.claimPoints, false);
  assert.equal(s.notifyDrops, false);
});

test("normalizeSettings ignore une valeur non booléenne", () => {
  const s = normalizeSettings({ enabled: "oui" });
  assert.equal(s.enabled, true);
});
