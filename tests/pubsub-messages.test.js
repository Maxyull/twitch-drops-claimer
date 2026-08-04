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

/** A frame as Twitch sends it: the useful message is JSON INSIDE JSON. */
const message = (topic, inner) =>
  JSON.stringify({ type: "MESSAGE", data: { topic, message: JSON.stringify(inner) } });

test("the topics are the account's, not a channel's", () => {
  assert.deepEqual(userTopics("12345"), [
    "community-points-user-v1.12345",
    "user-drop-events.12345",
  ]);
});

test("with no account id, we subscribe to nothing", () => {
  // Subscribing to `community-points-user-v1.` (empty topic) would get
  // l'ensemble de la trame par Twitch.
  for (const id of [null, undefined, "", "   "]) assert.deepEqual(userTopics(id), []);
});

test("the subscribe frame carries the token and the nonce", () => {
  const frame = listenFrame(["a", "b"], "abc", "n1");
  assert.equal(frame.type, "LISTEN");
  assert.equal(frame.nonce, "n1");
  assert.deepEqual(frame.data.topics, ["a", "b"]);
  assert.equal(frame.data.auth_token, "abc");
});

test("the OAuth prefix is stripped from the token", () => {
  // The captured header reads "OAuth abc"; PubSub wants the bare token.
  assert.equal(bareToken("OAuth abc"), "abc");
  assert.equal(bareToken("oauth  abc"), "abc");
  assert.equal(bareToken("Bearer abc"), "abc");
  assert.equal(bareToken("abc"), "abc");
  assert.equal(bareToken(null), "");
});

test("the endpoint really is Twitch's, over an encrypted connection", () => {
  assert.match(PUBSUB_URL, /^wss:\/\/pubsub-edge\.twitch\.tv\//);
});

test("an available chest is recognised", () => {
  const evt = parseFrame(
    message("community-points-user-v1.42", {
      type: "claim-available",
      data: { claim: { id: "claim-1", channel_id: "999" } },
    }),
  );
  assert.deepEqual(evt, { kind: EVENT.POINTS_AVAILABLE, claimId: "claim-1", channelId: "999" });
});

test("a points gain says where it came from", () => {
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

test("drop progress is recognised", () => {
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

test("a tier ready to claim carries its instance", () => {
  const evt = parseFrame(
    message("user-drop-events.42", {
      type: "drop-claim",
      data: { drop_id: "d1", drop_instance_id: "inst-1" },
    }),
  );
  assert.deepEqual(evt, { kind: EVENT.DROP_CLAIM, dropID: "d1", dropInstanceID: "inst-1" });
});

test("PONG, RECONNECT and RESPONSE are told apart", () => {
  assert.equal(parseFrame(JSON.stringify({ type: "PONG" })).kind, EVENT.PONG);
  assert.equal(parseFrame(JSON.stringify({ type: "RECONNECT" })).kind, EVENT.RECONNECT);

  const ok = parseFrame(JSON.stringify({ type: "RESPONSE", nonce: "n1", error: "" }));
  assert.deepEqual(ok, { kind: EVENT.RESPONSE, nonce: "n1", error: null });

  const ko = parseFrame(JSON.stringify({ type: "RESPONSE", nonce: "n1", error: "ERR_BADAUTH" }));
  assert.equal(ko.error, "ERR_BADAUTH");
});

test("REGRESSION: an unreadable frame never brings the loop down", () => {
  // This channel is only an acceleration. The day Twitch changes a frame, the
  // extension must keep running on its periodic queries, not stop on an
  // exception.
  const nimporteQuoi = [
    "",
    "not json",
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

test("REGRESSION: a topic from another channel does not pass for ours", () => {
  // The topics look alike: too broad a match would take a points event for a
  // drop event.
  const evt = parseFrame(
    message("community-points-channel-v1.42", {
      type: "claim-available",
      data: { claim: { id: "x" } },
    }),
  );
  assert.equal(evt.kind, EVENT.UNKNOWN);
});
