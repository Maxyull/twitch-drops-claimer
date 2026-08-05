import test from "node:test";
import assert from "node:assert/strict";

import { ERROR, describe, describeThrown, isDescriptor, formatError } from "../src/lib/errors.js";

/** A translator that shows what it was handed, so the test asserts on the wiring. */
const fake = (key, params = []) => `${key}(${params.join("|")})`;

test("a descriptor carries a key and stringified parameters", () => {
  assert.deepEqual(describe(ERROR.HTTP, [503]), { key: "error_http", params: ["503"] });
  assert.deepEqual(describe(ERROR.AUTH), { key: "error_auth", params: [] });
  assert.deepEqual(describe(ERROR.NETWORK, "boom").params, ["boom"]);
});

test("a GqlError kind becomes the matching key", () => {
  const err = Object.assign(new Error("Twitch answered HTTP 503"), { kind: "http", params: ["503"] });
  assert.deepEqual(describeThrown(err), { key: ERROR.HTTP, params: ["503"] });
});

// The whole point of the module: what a user reads must come from the catalogue,
// so an error we did not raise cannot smuggle a developer sentence into the popup
// unframed. It is quoted inside a translated one.
test("an error we did not raise is quoted inside a translated frame", () => {
  const res = describeThrown(new TypeError("x is not a function"));
  assert.equal(res.key, ERROR.UNKNOWN);
  assert.deepEqual(res.params, ["x is not a function"]);
  assert.equal(formatError(res, fake), "error_unknown(x is not a function)");
});

test("something thrown that is not an Error at all", () => {
  assert.deepEqual(describeThrown("plain string"), { key: ERROR.UNKNOWN, params: ["plain string"] });
  assert.equal(describeThrown(null).key, ERROR.UNKNOWN);
});

test("isDescriptor tells a descriptor from the legacy shape", () => {
  assert.equal(isDescriptor(describe(ERROR.AUTH)), true);
  assert.equal(isDescriptor({ message: "old" }), false);
  assert.equal(isDescriptor(null), false);
  assert.equal(isDescriptor("error_auth"), false);
});

test("formatError translates a descriptor, empty in, empty out", () => {
  assert.equal(formatError(describe(ERROR.HTTP, ["503"]), fake), "error_http(503)");
  assert.equal(formatError(null, fake), "");
  assert.equal(formatError({}, fake), "");
});

// `lastError` lives in storage.local and survives an update. An entry written by a
// version from before #76 is read once after the upgrade: showing its sentence one
// last time beats showing a raw key, and it disappears on the next write.
test("REGRESSION: an entry written before the descriptor shape still reads", () => {
  assert.equal(formatError({ message: "Stockage : quota" }, fake), "Stockage : quota");
});
