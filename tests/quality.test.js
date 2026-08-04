import test from "node:test";
import assert from "node:assert/strict";

import { AUDIO_ONLY, chooseQualityIndex, isAudioLabel } from "../src/lib/quality.js";
import { QUALITIES } from "../src/lib/settings.js";

// Ce que Twitch affiche vraiment, dans l'ordre du menu.
const MENU_EN = ["Auto", "Source (1080p60)", "720p60", "720p", "480p", "360p", "160p", "Audio Only"];
const MENU_FR = ["Auto", "Source (1080p60)", "720p60", "480p", "360p", "160p", "Audio seulement"];
const SANS_AUDIO = ["Auto", "720p60", "480p", "360p", "160p"];

test("l'audio seul est une qualité proposable", () => {
  assert.ok(QUALITIES.includes(AUDIO_ONLY));
});

test("isAudioLabel ne confond pas Audio et Auto", () => {
  assert.equal(isAudioLabel("Audio Only"), true);
  assert.equal(isAudioLabel("Audio seulement"), true);
  assert.equal(isAudioLabel("Nur Audio"), true);
  assert.equal(isAudioLabel("Auto"), false);
  assert.equal(isAudioLabel("Source (1080p60)"), false);
  assert.equal(isAudioLabel("160p"), false);
});

test("audio seul demandé : on clique l'entrée sans image", () => {
  assert.equal(chooseQualityIndex(MENU_EN, AUDIO_ONLY), 7);
  assert.equal(chooseQualityIndex(MENU_FR, AUDIO_ONLY), 6);
});

test("audio seul demandé mais non proposé : on ne touche à rien", () => {
  // Dégrader au hasard vaudrait moins que laisser le lecteur tranquille.
  assert.equal(chooseQualityIndex(SANS_AUDIO, AUDIO_ONLY), -1);
});

test("RÉGRESSION : « la plus basse » ne doit pas couper l'image", () => {
  // L'audio seul est la DERNIÈRE entrée du menu. Prendre la dernière pour
  // économiser la bande passante coupait donc l'image sans le vouloir, et
  // `videoEl()` écartait alors le lecteur qu'il fallait suivre.
  assert.equal(chooseQualityIndex(MENU_EN, "160p30"), 6, "160p, pas Audio Only");
  assert.equal(MENU_EN[chooseQualityIndex(MENU_EN, "160p30")], "160p");
  assert.equal(MENU_FR[chooseQualityIndex(MENU_FR, "160p30")], "160p");
});

test("sans entrée audio, la plus basse reste la dernière", () => {
  assert.equal(SANS_AUDIO[chooseQualityIndex(SANS_AUDIO, "160p30")], "160p");
});

test("un menu vide ou illisible ne fait cliquer nulle part", () => {
  assert.equal(chooseQualityIndex([], "160p30"), -1);
  assert.equal(chooseQualityIndex(null, AUDIO_ONLY), -1);
  assert.equal(chooseQualityIndex(["Audio Only"], "160p30"), -1, "rien d'autre à choisir");
});
