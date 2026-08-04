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

test("a short outage bothers nobody", () => {
  const res = evaluateAlert(rouge({ brokenSince: NOW - 60_000 }), { now: NOW });
  assert.equal(res.notify, false);
  assert.equal(res.brokenSince, NOW - 60_000, "but we remember since when");
});

test("the first outage records when it started", () => {
  const res = evaluateAlert(rouge(), { now: NOW });
  assert.equal(res.brokenSince, NOW);
  assert.equal(res.notify, false);
});

test("past the delay, we warn", () => {
  const res = evaluateAlert(rouge({ brokenSince: NOW - DEFAULT_ALERT_AFTER_MS }), { now: NOW });
  assert.equal(res.notify, true);
  assert.equal(res.alertedAt, NOW);
});

test("REGRESSION: a lasting outage does not notify on every cycle", () => {
  // One notification a minute through the night would get the extension
  // uninstalled more surely than the outage itself.
  const apres = evaluateAlert(
    rouge({ brokenSince: NOW - 2 * DEFAULT_ALERT_AFTER_MS, alertedAt: NOW - 60_000 }),
    { now: NOW },
  );
  assert.equal(apres.notify, false);

  const bienPlusTard = evaluateAlert(
    rouge({ brokenSince: NOW - 10 * REPEAT_AFTER_MS, alertedAt: NOW - REPEAT_AFTER_MS }),
    { now: NOW },
  );
  assert.equal(bienPlusTard.notify, true, "but we say it again once an hour");
});

test("REGRESSION: having nothing to do is not an outage", () => {
  // With no favourite channel and no live campaign, the extension is idle.
  // Alerting on that would teach the user to ignore alerts.
  const repos = evaluateAlert({ green: false, code: "disabled", brokenSince: NOW - 10 * 60_000 }, {
    now: NOW,
    afterMs: 0,
  });
  assert.equal(repos.notify, false);
  assert.equal(repos.brokenSince, null, "and the outage counter starts again from zero");
});

test("going back to green clears the outage", () => {
  const res = evaluateAlert(
    { green: true, code: "ok", brokenSince: NOW - 60 * 60_000, alertedAt: NOW - 60_000 },
    { now: NOW },
  );
  assert.deepEqual(res, { brokenSince: null, alertedAt: null, notify: false, brokenFor: 0 });
});

test("an outage returning after a green spell starts again from zero", () => {
  const remis = evaluateAlert({ green: true, code: "ok", brokenSince: NOW - 60_000 }, { now: NOW });
  const rechute = evaluateAlert(rouge({ ...remis }), { now: NOW + 1000 });
  assert.equal(rechute.brokenSince, NOW + 1000);
  assert.equal(rechute.notify, false, "the delay restarts, no immediate alert");
});

test("the delay is configurable", () => {
  const res = evaluateAlert(rouge({ brokenSince: NOW - 5 * 60_000 }), {
    now: NOW,
    afterMs: 5 * 60_000,
  });
  assert.equal(res.notify, true);
});

test("minutesOf reste lisible", () => {
  assert.equal(minutesOf(0), 1, "never zero minutes");
  assert.equal(minutesOf(90_000), 2);
  assert.equal(minutesOf(15 * 60_000), 15);
});
