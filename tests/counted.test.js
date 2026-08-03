import test from "node:test";
import assert from "node:assert/strict";

import {
  COUNTED,
  SPADE_MAX_AGE_MS,
  SEGMENT_MAX_AGE_MS,
  WARMUP_MS,
  evaluateCounted,
  isCounted,
  classifyRequest,
} from "../src/lib/counted.js";

const NOW = 1_800_000_000_000;

test("un ping de comptage récent est la preuve la plus forte", () => {
  const res = evaluateCounted({ spadeAt: NOW - 10_000 }, { now: NOW });
  assert.equal(res.code, COUNTED.CONFIRMED);
  assert.equal(res.spadeAge, 10_000);
});

test("sans ping mais avec des segments, on ne conclut pas au négatif", () => {
  // Cas réel : un bloqueur de pub tue le ping sans empêcher le comptage.
  const res = evaluateCounted(
    { spadeAt: null, segmentAt: NOW - 5_000 },
    { now: NOW },
  );
  assert.equal(res.code, COUNTED.STREAMING);
  assert.equal(isCounted(res.code), true);
});

test("le ping prime sur les segments", () => {
  const res = evaluateCounted({ spadeAt: NOW - 1_000, segmentAt: NOW - 1_000 }, { now: NOW });
  assert.equal(res.code, COUNTED.CONFIRMED);
});

test("des signaux trop vieux ne comptent plus", () => {
  const vieux = {
    spadeAt: NOW - SPADE_MAX_AGE_MS - 1,
    segmentAt: NOW - SEGMENT_MAX_AGE_MS - 1,
  };
  assert.equal(evaluateCounted(vieux, { now: NOW }).code, COUNTED.NO);
});

test("RÉGRESSION : un lecteur à l'arrêt n'est jamais compté", () => {
  // Même avec un ping tout frais : si la vidéo ne tourne pas, le temps ne compte pas.
  const res = evaluateCounted({ spadeAt: NOW }, { now: NOW, playing: false });
  assert.equal(res.code, COUNTED.NO);
});

test("on ne se prononce pas pendant la mise en route de l'onglet", () => {
  const res = evaluateCounted({}, { now: NOW, since: NOW - 10_000 });
  assert.equal(res.code, COUNTED.UNKNOWN);
  assert.equal(isCounted(res.code), false, "« en cours » n'est pas un oui");

  const apres = evaluateCounted({}, { now: NOW, since: NOW - WARMUP_MS - 1 });
  assert.equal(apres.code, COUNTED.NO);
});

test("aucun signal, aucune date de départ", () => {
  assert.equal(evaluateCounted(null, { now: NOW }).code, COUNTED.NO);
  assert.equal(evaluateCounted(undefined, { now: NOW }).spadeAge, null);
});

test("classifyRequest reconnaît les deux signaux et rien d'autre", () => {
  assert.equal(classifyRequest("https://spade.twitch.tv/track?x=1"), "spade");
  assert.equal(
    classifyRequest("https://video-edge-abc.abs.hls.ttvnw.net/v1/segment/xyz.ts"),
    "segment",
  );
  assert.equal(classifyRequest("https://gql.twitch.tv/gql"), null);
  assert.equal(classifyRequest("https://www.twitch.tv/zerator"), null);
});

test("RÉGRESSION : un domaine qui imite Twitch n'est pas reconnu", () => {
  assert.equal(classifyRequest("https://spade.twitch.tv.evil.example/track"), null);
  assert.equal(classifyRequest("https://ttvnw.net.evil.example/x"), null);
  assert.equal(classifyRequest("https://evil-ttvnw.net/x"), null);
  assert.equal(classifyRequest("http://spade.twitch.tv/track"), null, "HTTP refusé");
  assert.equal(classifyRequest("pas une url"), null);
  assert.equal(classifyRequest(null), null);
});
