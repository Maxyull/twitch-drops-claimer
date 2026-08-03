import test from "node:test";
import assert from "node:assert/strict";

import { evaluateBeat, summarize, statusLabel, isGreen, STATUS, BEAT_TIMEOUT_MS } from "../src/lib/status.js";

const NOW = 1_800_000_000_000;

function beat(overrides = {}) {
  return {
    at: NOW,
    channel: "zerator",
    paused: false,
    currentTime: 120,
    videoHeight: 160,
    ads: false,
    offline: false,
    ...overrides,
  };
}

test("vert quand le lecteur avance", () => {
  const s = evaluateBeat(beat(), beat({ at: NOW - 5000, currentTime: 115 }), {
    now: NOW,
    expectedChannel: "zerator",
  });
  assert.equal(s.code, STATUS.OK);
  assert.equal(s.green, true);
  assert.equal(s.channel, "zerator");
});

test("vert au tout premier battement, sans précédent", () => {
  const s = evaluateBeat(beat(), null, { now: NOW });
  assert.equal(s.code, STATUS.OK);
});

test("rouge : lecteur en pause", () => {
  const s = evaluateBeat(beat({ paused: true }), null, { now: NOW });
  assert.equal(s.code, STATUS.PAUSED);
  assert.equal(s.green, false);
});

test("rouge : flux figé (l'horloge de la vidéo n'avance plus)", () => {
  const s = evaluateBeat(beat({ currentTime: 120 }), beat({ at: NOW - 5000, currentTime: 120 }), {
    now: NOW,
  });
  assert.equal(s.code, STATUS.STALLED);
  assert.equal(s.green, false);
});

test("rouge : plus de battement depuis trop longtemps", () => {
  const s = evaluateBeat(beat({ at: NOW - BEAT_TIMEOUT_MS - 1 }), null, { now: NOW });
  assert.equal(s.code, STATUS.NO_BEAT);
  assert.equal(s.green, false);
});

test("rouge : onglet fermé, chaîne hors ligne, mauvaise chaîne", () => {
  assert.equal(evaluateBeat(beat(), null, { now: NOW, tabExists: false }).code, STATUS.NO_TAB);
  assert.equal(evaluateBeat(beat({ offline: true }), null, { now: NOW }).code, STATUS.OFFLINE);
  assert.equal(
    evaluateBeat(beat({ channel: "autre" }), null, { now: NOW, expectedChannel: "zerator" }).code,
    STATUS.WRONG_CHANNEL,
  );
});

test("vert pendant une publicité : le temps continue de compter", () => {
  const s = evaluateBeat(beat({ ads: true, paused: true }), null, { now: NOW });
  assert.equal(s.code, STATUS.ADS);
  assert.equal(s.green, true);
});

test("désactivé n'est ni vert ni une erreur à corriger", () => {
  const s = evaluateBeat(beat(), null, { now: NOW, enabled: false });
  assert.equal(s.code, STATUS.DISABLED);
  assert.equal(s.green, false);
});

test("aucun battement du tout", () => {
  assert.equal(evaluateBeat(null, null, { now: NOW }).code, STATUS.NO_BEAT);
});

test("isGreen et statusLabel restent cohérents", () => {
  assert.equal(isGreen(STATUS.OK), true);
  assert.equal(isGreen(STATUS.ADS), true);
  assert.equal(isGreen(STATUS.STALLED), false);
  assert.equal(typeof statusLabel(STATUS.NO_TAB), "string");
  assert.equal(statusLabel("code-inconnu"), "code-inconnu");
});

test("summarize remonte le premier problème", () => {
  const ok = evaluateBeat(beat(), null, { now: NOW });
  const ko = evaluateBeat(beat({ paused: true }), null, { now: NOW });
  assert.equal(summarize([ok, ok]).green, true);
  assert.equal(summarize([ok, ko]).green, false);
  assert.equal(summarize([ok, ko]).code, STATUS.PAUSED);
});

test("summarize ignore les voyants désactivés", () => {
  const off = evaluateBeat(beat(), null, { now: NOW, enabled: false });
  const ok = evaluateBeat(beat(), null, { now: NOW });
  assert.equal(summarize([off, ok]).green, true);
  assert.equal(summarize([off, off]).code, STATUS.DISABLED);
  assert.equal(summarize([]).green, false);
});
