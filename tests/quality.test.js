import test from "node:test";
import assert from "node:assert/strict";

import { AUDIO_ONLY, chooseQualityIndex, isAudioLabel } from "../src/lib/quality.js";
import { QUALITIES } from "../src/lib/settings.js";

// What Twitch actually displays, in menu order.
const MENU_EN = ["Auto", "Source (1080p60)", "720p60", "720p", "480p", "360p", "160p", "Audio Only"];
const MENU_FR = ["Auto", "Source (1080p60)", "720p60", "480p", "360p", "160p", "Audio seulement"];
const SANS_AUDIO = ["Auto", "720p60", "480p", "360p", "160p"];

test("audio-only is a quality that can be offered", () => {
  assert.ok(QUALITIES.includes(AUDIO_ONLY));
});

test("isAudioLabel does not confuse Audio with Auto", () => {
  assert.equal(isAudioLabel("Audio Only"), true);
  assert.equal(isAudioLabel("Audio seulement"), true);
  assert.equal(isAudioLabel("Nur Audio"), true);
  assert.equal(isAudioLabel("Auto"), false);
  assert.equal(isAudioLabel("Source (1080p60)"), false);
  assert.equal(isAudioLabel("160p"), false);
});

test("audio-only requested: we click the entry with no picture", () => {
  assert.equal(chooseQualityIndex(MENU_EN, AUDIO_ONLY), 7);
  assert.equal(chooseQualityIndex(MENU_FR, AUDIO_ONLY), 6);
});

test("audio-only requested but not offered: we touch nothing", () => {
  // Degrading at random would be worth less than leaving the player alone.
  assert.equal(chooseQualityIndex(SANS_AUDIO, AUDIO_ONLY), -1);
});

test("REGRESSION: \"the lowest\" must not cut the picture", () => {
  // Audio-only is the LAST entry in the menu. Taking the last one to save
  // bandwidth therefore cut the picture without meaning to, and `videoEl()` then
  // discarded the very player it needed to follow.
  assert.equal(chooseQualityIndex(MENU_EN, "160p30"), 6, "160p, not Audio Only");
  assert.equal(MENU_EN[chooseQualityIndex(MENU_EN, "160p30")], "160p");
  assert.equal(MENU_FR[chooseQualityIndex(MENU_FR, "160p30")], "160p");
});

test("with no audio entry, the lowest is still the last one", () => {
  assert.equal(SANS_AUDIO[chooseQualityIndex(SANS_AUDIO, "160p30")], "160p");
});

test("un menu vide ou illisible ne fait cliquer nulle part", () => {
  assert.equal(chooseQualityIndex([], "160p30"), -1);
  assert.equal(chooseQualityIndex(null, AUDIO_ONLY), -1);
  assert.equal(chooseQualityIndex(["Audio Only"], "160p30"), -1, "nothing else to choose from");
});
