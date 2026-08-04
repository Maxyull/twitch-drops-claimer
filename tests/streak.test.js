import test from "node:test";
import assert from "node:assert/strict";

import { FRESH_MINUTES, STREAK_MINUTES, rankForStreak, streakReachable } from "../src/lib/streak.js";

const NOW = 1_800_000_000_000;
const min = (n) => n * 60_000;

test("un flux qui vient d'ouvrir peut rapporter la série", () => {
  assert.equal(streakReachable({ startedAt: NOW - min(2), watchedMs: 0 }, { now: NOW }), true);
});

test("un flux allumé depuis des heures ne rapporte plus rien", () => {
  assert.equal(streakReachable({ startedAt: NOW - min(360), watchedMs: 0 }, { now: NOW }), false);
  assert.equal(
    streakReachable({ startedAt: NOW - min(FRESH_MINUTES + 1), watchedMs: 0 }, { now: NOW }),
    false,
  );
});

test("RÉGRESSION : une série déjà acquise n'est pas re-priorisée", () => {
  // Six minutes suffisent au bonus, et il ne se redonne pas sur le même flux.
  // Sans cette borne, l'extension resterait collée à la même chaîne fraîche au
  // lieu d'aller chercher la suivante.
  const assez = { startedAt: NOW - min(10), watchedMs: min(STREAK_MINUTES) };
  assert.equal(streakReachable(assez, { now: NOW }), false);
  assert.equal(streakReachable({ ...assez, watchedMs: min(6) }, { now: NOW }), true);
});

test("RÉGRESSION : sans date de début, on ne prétend pas que oui", () => {
  // Twitch ne renvoie pas toujours `createdAt`. Deviner « c'est frais » ferait
  // zapper une chaîne qui marche pour une autre sans raison.
  for (const startedAt of [undefined, null, 0, NaN, "hier"]) {
    assert.equal(streakReachable({ startedAt, watchedMs: 0 }, { now: NOW }), false);
  }
});

test("une date dans le futur n'est pas de la fraîcheur", () => {
  assert.equal(streakReachable({ startedAt: NOW + min(5), watchedMs: 0 }, { now: NOW }), false);
});

test("l'ordre met les séries atteignables devant, la plus fraîche en tête", () => {
  const ordre = rankForStreak(
    [
      { login: "ancienne", startedAt: NOW - min(200), watchedMs: 0 },
      { login: "fraiche", startedAt: NOW - min(12), watchedMs: 0 },
      { login: "toutefraiche", startedAt: NOW - min(1), watchedMs: 0 },
    ],
    { now: NOW },
  );
  assert.deepEqual(ordre, ["toutefraiche", "fraiche", "ancienne"]);
});

test("RÉGRESSION : sans candidat à la série, l'ordre de l'utilisateur est conservé", () => {
  // La liste de favorites est saisie dans un ordre voulu. Le tri par série ne
  // doit pas le réinventer quand il n'a rien à apporter.
  const saisi = [
    { login: "a", startedAt: NOW - min(300), watchedMs: 0 },
    { login: "b", startedAt: NOW - min(100), watchedMs: 0 },
    { login: "c", startedAt: 0, watchedMs: 0 },
  ];
  assert.deepEqual(rankForStreak(saisi, { now: NOW }), ["a", "b", "c"]);
});

test("les non éligibles gardent leur ordre derrière les éligibles", () => {
  const ordre = rankForStreak(
    [
      { login: "a", startedAt: NOW - min(300), watchedMs: 0 },
      { login: "fraiche", startedAt: NOW - min(3), watchedMs: 0 },
      { login: "b", startedAt: NOW - min(100), watchedMs: 0 },
    ],
    { now: NOW },
  );
  assert.deepEqual(ordre, ["fraiche", "a", "b"]);
});

test("une liste vide ou illisible ne casse rien", () => {
  assert.deepEqual(rankForStreak([], { now: NOW }), []);
  assert.deepEqual(rankForStreak(null, { now: NOW }), []);
  assert.deepEqual(rankForStreak([{}, { login: "" }, { login: "a" }], { now: NOW }), ["a"]);
});
