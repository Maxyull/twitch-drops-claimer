import test from "node:test";
import assert from "node:assert/strict";

import {
  COUNTED,
  REASON,
  PROGRESS_MAX_AGE_MS,
  SPADE_MAX_AGE_MS,
  SEGMENT_MAX_AGE_MS,
  WARMUP_MS,
  evaluateCounted,
  isCounted,
  progressAdvanced,
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

test("la progression observée est la preuve la plus forte", () => {
  const res = evaluateCounted({ progressAt: NOW - 60_000 }, { now: NOW });
  assert.equal(res.code, COUNTED.CONFIRMED);
  assert.equal(res.progressAge, 60_000);
});

test("RÉGRESSION : une preuve l'emporte sur l'état supposé du lecteur", () => {
  // Le cas signalé : « c'est écrit non compté mais j'ai eu des drops ». Notre
  // lecture du lecteur peut se tromper, la progression non. Elle gagne.
  const progression = evaluateCounted({ progressAt: NOW }, { now: NOW, playing: false });
  assert.equal(progression.code, COUNTED.CONFIRMED);

  const ping = evaluateCounted({ spadeAt: NOW }, { now: NOW, playing: false });
  assert.equal(ping.code, COUNTED.CONFIRMED);

  const segments = evaluateCounted({ segmentAt: NOW }, { now: NOW, playing: false });
  assert.equal(segments.code, COUNTED.STREAMING);
});

test("sans aucune preuve, un lecteur à l'arrêt n'est pas compté", () => {
  assert.equal(evaluateCounted({}, { now: NOW, playing: false }).code, COUNTED.NO);
});

test("un « non compté » dit toujours pourquoi", () => {
  // Trois causes, trois gestes différents : sans la raison, on cherche au hasard.
  // Le lecteur à l'arrêt n'est retenu que si aucune preuve ne le contredit.
  const arret = evaluateCounted(
    { segmentAt: NOW - SEGMENT_MAX_AGE_MS - 1 },
    { now: NOW, playing: false },
  );
  assert.equal(arret.code, COUNTED.NO);
  assert.equal(arret.reason, REASON.PLAYER_STOPPED);

  const rien = evaluateCounted({}, { now: NOW, since: NOW - WARMUP_MS - 1 });
  assert.equal(rien.code, COUNTED.NO);
  assert.equal(rien.reason, REASON.NO_SIGNAL, "aucun signal n'a jamais été vu");

  const perime = evaluateCounted(
    { segmentAt: NOW - SEGMENT_MAX_AGE_MS - 1 },
    { now: NOW, since: NOW - WARMUP_MS - 1 },
  );
  assert.equal(perime.code, COUNTED.NO);
  assert.equal(perime.reason, REASON.STALE, "on a déjà vu passer quelque chose");
});

test("un état positif ou indécis ne porte pas de raison", () => {
  assert.equal(evaluateCounted({ progressAt: NOW }, { now: NOW }).reason, null);
  assert.equal(evaluateCounted({ segmentAt: NOW }, { now: NOW }).reason, null);
  assert.equal(evaluateCounted({}, { now: NOW, since: NOW }).reason, null);
});

test("une progression trop ancienne ne prouve plus rien", () => {
  const vieille = { progressAt: NOW - PROGRESS_MAX_AGE_MS - 1 };
  assert.equal(evaluateCounted(vieille, { now: NOW }).code, COUNTED.NO);
});

test("progressAdvanced n'accepte que deux nombres et une hausse réelle", () => {
  assert.equal(progressAdvanced(10, 11), true);
  assert.equal(progressAdvanced(10, 10), false, "stagner n'est pas progresser");
  assert.equal(progressAdvanced(10, 9), false);
  assert.equal(progressAdvanced(undefined, 5), false, "premier relevé, rien à comparer");
  assert.equal(progressAdvanced(5, null), false);
  assert.equal(progressAdvanced("10", 11), false);
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
