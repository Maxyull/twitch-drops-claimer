import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_ALERT_AFTER_MS,
  REPEAT_AFTER_MS,
  evaluateAlert,
  minutesOf,
} from "../src/lib/alert.js";

const NOW = 1_800_000_000_000;
const rouge = (extra = {}) => ({ green: false, code: "offline", ...extra });

test("une panne courte ne dérange personne", () => {
  const res = evaluateAlert(rouge({ brokenSince: NOW - 60_000 }), { now: NOW });
  assert.equal(res.notify, false);
  assert.equal(res.brokenSince, NOW - 60_000, "mais on retient depuis quand");
});

test("la première panne mémorise son début", () => {
  const res = evaluateAlert(rouge(), { now: NOW });
  assert.equal(res.brokenSince, NOW);
  assert.equal(res.notify, false);
});

test("passé le délai, on prévient", () => {
  const res = evaluateAlert(rouge({ brokenSince: NOW - DEFAULT_ALERT_AFTER_MS }), { now: NOW });
  assert.equal(res.notify, true);
  assert.equal(res.alertedAt, NOW);
});

test("RÉGRESSION : une panne qui dure ne notifie pas à chaque cycle", () => {
  // Une notification par minute pendant la nuit ferait désinstaller l'extension
  // plus sûrement que la panne elle-même.
  const apres = evaluateAlert(
    rouge({ brokenSince: NOW - 2 * DEFAULT_ALERT_AFTER_MS, alertedAt: NOW - 60_000 }),
    { now: NOW },
  );
  assert.equal(apres.notify, false);

  const bienPlusTard = evaluateAlert(
    rouge({ brokenSince: NOW - 10 * REPEAT_AFTER_MS, alertedAt: NOW - REPEAT_AFTER_MS }),
    { now: NOW },
  );
  assert.equal(bienPlusTard.notify, true, "mais on redit une fois par heure");
});

test("RÉGRESSION : ne rien avoir à faire n'est pas une panne", () => {
  // Sans chaîne favorite ni campagne en direct, l'extension est au repos.
  // Alerter là-dessus apprendrait à ignorer les alertes.
  const repos = evaluateAlert({ green: false, code: "disabled", brokenSince: NOW - 10 * 60_000 }, {
    now: NOW,
    afterMs: 0,
  });
  assert.equal(repos.notify, false);
  assert.equal(repos.brokenSince, null, "et le compteur de panne repart de zéro");
});

test("le retour au vert efface la panne", () => {
  const res = evaluateAlert(
    { green: true, code: "ok", brokenSince: NOW - 60 * 60_000, alertedAt: NOW - 60_000 },
    { now: NOW },
  );
  assert.deepEqual(res, { brokenSince: null, alertedAt: null, notify: false, brokenFor: 0 });
});

test("une panne qui revient après un retour au vert repart à zéro", () => {
  const remis = evaluateAlert({ green: true, code: "ok", brokenSince: NOW - 60_000 }, { now: NOW });
  const rechute = evaluateAlert(rouge({ ...remis }), { now: NOW + 1000 });
  assert.equal(rechute.brokenSince, NOW + 1000);
  assert.equal(rechute.notify, false, "le délai recommence, pas d'alerte immédiate");
});

test("le délai est réglable", () => {
  const res = evaluateAlert(rouge({ brokenSince: NOW - 5 * 60_000 }), {
    now: NOW,
    afterMs: 5 * 60_000,
  });
  assert.equal(res.notify, true);
});

test("minutesOf reste lisible", () => {
  assert.equal(minutesOf(0), 1, "jamais zéro minute");
  assert.equal(minutesOf(90_000), 2);
  assert.equal(minutesOf(15 * 60_000), 15);
});
