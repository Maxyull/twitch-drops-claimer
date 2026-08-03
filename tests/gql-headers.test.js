import test from "node:test";
import assert from "node:assert/strict";

import {
  FORWARDED_HEADERS,
  HEADERS_MAX_AGE_MS,
  pickForwardableHeaders,
  isUsable,
  isStale,
  buildRequestHeaders,
} from "../src/lib/gql-headers.js";

const NOW = 1_800_000_000_000;

/** En-têtes tels que webRequest les fournit pour une requête réelle de la page. */
function realHeaders(overrides = []) {
  return [
    { name: "Authorization", value: "OAuth abcdef123456" },
    { name: "Client-Id", value: "kimne78kx3ncx6brgo4mv6wki5h1ko" },
    { name: "Client-Integrity", value: "v4.public.jeton-integrite" },
    { name: "Client-Session-Id", value: "1a2b3c" },
    { name: "Client-Version", value: "abc-123" },
    { name: "X-Device-Id", value: "device-42" },
    { name: "Accept-Language", value: "fr-FR" },
    { name: "Content-Type", value: "text/plain;charset=UTF-8" },
    { name: "Content-Length", value: "512" },
    { name: "User-Agent", value: "Mozilla/5.0" },
    { name: "Cookie", value: "auth-token=secret; unique_id=xyz" },
    { name: "Referer", value: "https://www.twitch.tv/" },
    ...overrides,
  ];
}

test("ne reprend que les en-têtes utiles à l'API", () => {
  const picked = pickForwardableHeaders(realHeaders());
  assert.deepEqual(Object.keys(picked).sort(), [
    "Accept-Language",
    "Authorization",
    "Client-Id",
    "Client-Integrity",
    "Client-Session-Id",
    "Client-Version",
    "X-Device-Id",
  ]);
});

test("RÉGRESSION : le cookie n'est jamais repris", () => {
  // Le cookie porte la session complète et n'a rien à faire dans notre requête :
  // le navigateur ne l'enverra pas, et le stocker serait une fuite inutile.
  const picked = pickForwardableHeaders(realHeaders());
  assert.equal("Cookie" in picked, false);
  assert.equal(JSON.stringify(picked).includes("auth-token=secret"), false);
  assert.equal(FORWARDED_HEADERS.has("cookie"), false);
});

test("le nom d'origine est conservé, la comparaison est insensible à la casse", () => {
  const picked = pickForwardableHeaders([{ name: "client-INTEGRITY", value: "jeton" }]);
  assert.deepEqual(picked, { "client-INTEGRITY": "jeton" });
});

test("les en-têtes vides ou mal formés sont ignorés", () => {
  const picked = pickForwardableHeaders([
    { name: "Client-Integrity", value: "" },
    { name: "Authorization", value: null },
    { name: 42, value: "x" },
    null,
  ]);
  assert.deepEqual(picked, {});
  assert.deepEqual(pickForwardableHeaders(undefined), {});
});

test("une capture n'est exploitable qu'avec intégrité ET autorisation", () => {
  const complet = { headers: pickForwardableHeaders(realHeaders()), at: NOW };
  assert.equal(isUsable(complet), true);

  const sansIntegrite = { headers: { Authorization: "OAuth x" }, at: NOW };
  assert.equal(isUsable(sansIntegrite), false, "c'est précisément ce qui manquait");

  const sansAuth = { headers: { "Client-Integrity": "jeton" }, at: NOW };
  assert.equal(isUsable(sansAuth), false);
  assert.equal(isUsable(null), false);
  assert.equal(isUsable({}), false);
});

test("une capture se périme", () => {
  assert.equal(isStale({ at: NOW }, NOW), false);
  assert.equal(isStale({ at: NOW - HEADERS_MAX_AGE_MS + 1000 }, NOW), false);
  assert.equal(isStale({ at: NOW - HEADERS_MAX_AGE_MS - 1000 }, NOW), true);
  assert.equal(isStale(null, NOW), true);
  assert.equal(isStale({}, NOW), true);
});

test("la requête sortante impose son propre Content-Type", () => {
  const captured = { headers: pickForwardableHeaders(realHeaders()), at: NOW };
  const headers = buildRequestHeaders(captured);
  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(headers["Client-Integrity"], "v4.public.jeton-integrite");
  assert.equal(headers.Authorization, "OAuth abcdef123456");
});
