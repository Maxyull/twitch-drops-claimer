import test from "node:test";
import assert from "node:assert/strict";

import {
  EVENT,
  PUBSUB_URL,
  bareToken,
  listenFrame,
  parseFrame,
  userTopics,
} from "../src/lib/pubsub-messages.js";

/** Trame telle que Twitch l'envoie : le message utile est du JSON DANS du JSON. */
const message = (topic, inner) =>
  JSON.stringify({ type: "MESSAGE", data: { topic, message: JSON.stringify(inner) } });

test("les sujets sont ceux du compte, pas d'une chaîne", () => {
  assert.deepEqual(userTopics("12345"), [
    "community-points-user-v1.12345",
    "user-drop-events.12345",
  ]);
});

test("sans identifiant de compte, on ne s'abonne à rien", () => {
  // S'abonner à `community-points-user-v1.` (sujet vide) ferait refuser
  // l'ensemble de la trame par Twitch.
  for (const id of [null, undefined, "", "   "]) assert.deepEqual(userTopics(id), []);
});

test("la trame d'abonnement porte le jeton et le nonce", () => {
  const frame = listenFrame(["a", "b"], "abc", "n1");
  assert.equal(frame.type, "LISTEN");
  assert.equal(frame.nonce, "n1");
  assert.deepEqual(frame.data.topics, ["a", "b"]);
  assert.equal(frame.data.auth_token, "abc");
});

test("le préfixe OAuth est retiré du jeton", () => {
  // L'en-tête capturé vaut « OAuth abc » ; PubSub veut le jeton nu.
  assert.equal(bareToken("OAuth abc"), "abc");
  assert.equal(bareToken("oauth  abc"), "abc");
  assert.equal(bareToken("Bearer abc"), "abc");
  assert.equal(bareToken("abc"), "abc");
  assert.equal(bareToken(null), "");
});

test("le point d'entrée est bien celui de Twitch, en chiffré", () => {
  assert.match(PUBSUB_URL, /^wss:\/\/pubsub-edge\.twitch\.tv\//);
});

test("un coffre disponible est reconnu", () => {
  const evt = parseFrame(
    message("community-points-user-v1.42", {
      type: "claim-available",
      data: { claim: { id: "claim-1", channel_id: "999" } },
    }),
  );
  assert.deepEqual(evt, { kind: EVENT.POINTS_AVAILABLE, claimId: "claim-1", channelId: "999" });
});

test("un gain de points dit d'où il vient", () => {
  const evt = parseFrame(
    message("community-points-user-v1.42", {
      type: "points-earned",
      data: {
        channel_id: "999",
        balance: { balance: 1234 },
        point_gain: { total_points: 450, reason_code: "WATCH_STREAK" },
      },
    }),
  );
  assert.equal(evt.kind, EVENT.POINTS_EARNED);
  assert.equal(evt.balance, 1234);
  assert.equal(evt.gained, 450);
  assert.equal(evt.reason, "WATCH_STREAK");
});

test("une progression de drop est reconnue", () => {
  const evt = parseFrame(
    message("user-drop-events.42", {
      type: "drop-progress",
      data: { drop_id: "d1", current_progress_min: 12, required_progress_min: 60 },
    }),
  );
  assert.deepEqual(evt, {
    kind: EVENT.DROP_PROGRESS,
    dropID: "d1",
    watchedMinutes: 12,
    requiredMinutes: 60,
  });
});

test("un palier prêt à réclamer porte son instance", () => {
  const evt = parseFrame(
    message("user-drop-events.42", {
      type: "drop-claim",
      data: { drop_id: "d1", drop_instance_id: "inst-1" },
    }),
  );
  assert.deepEqual(evt, { kind: EVENT.DROP_CLAIM, dropID: "d1", dropInstanceID: "inst-1" });
});

test("PONG, RECONNECT et RESPONSE sont distingués", () => {
  assert.equal(parseFrame(JSON.stringify({ type: "PONG" })).kind, EVENT.PONG);
  assert.equal(parseFrame(JSON.stringify({ type: "RECONNECT" })).kind, EVENT.RECONNECT);

  const ok = parseFrame(JSON.stringify({ type: "RESPONSE", nonce: "n1", error: "" }));
  assert.deepEqual(ok, { kind: EVENT.RESPONSE, nonce: "n1", error: null });

  const ko = parseFrame(JSON.stringify({ type: "RESPONSE", nonce: "n1", error: "ERR_BADAUTH" }));
  assert.equal(ko.error, "ERR_BADAUTH");
});

test("RÉGRESSION : une trame illisible ne fait jamais tomber la boucle", () => {
  // Ce canal n'est qu'une accélération. Le jour où Twitch change une trame,
  // l'extension doit continuer à tourner sur ses interrogations périodiques,
  // pas s'arrêter sur une exception.
  const nimporteQuoi = [
    "",
    "pas du json",
    "null",
    "[]",
    JSON.stringify({ type: "MESSAGE" }),
    JSON.stringify({ type: "MESSAGE", data: { topic: "user-drop-events.42", message: "{{{" } }),
    message("user-drop-events.42", { type: "drop-progress", data: {} }),
    message("user-drop-events.42", { type: "drop-claim", data: {} }),
    message("community-points-user-v1.42", { type: "claim-available", data: {} }),
    message("sujet-inconnu.42", { type: "quelque-chose", data: {} }),
    message("user-drop-events.42", { type: "type-inconnu", data: {} }),
  ];

  for (const raw of nimporteQuoi) {
    const evt = parseFrame(raw);
    assert.equal(evt.kind, EVENT.UNKNOWN, JSON.stringify(raw).slice(0, 60));
  }
});

test("RÉGRESSION : un sujet d'une autre chaîne ne passe pas pour le nôtre", () => {
  // Les sujets se ressemblent : une correspondance trop large ferait prendre
  // un évènement de points pour un évènement de drop.
  const evt = parseFrame(
    message("community-points-channel-v1.42", {
      type: "claim-available",
      data: { claim: { id: "x" } },
    }),
  );
  assert.equal(evt.kind, EVENT.UNKNOWN);
});
