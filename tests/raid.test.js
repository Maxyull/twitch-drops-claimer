import test from "node:test";
import assert from "node:assert/strict";

import {
  EVENT,
  channelTopics,
  parseFrame,
  topicDelta,
  unlistenFrame,
  userTopics,
} from "../src/lib/pubsub-messages.js";

const message = (topic, inner) =>
  JSON.stringify({ type: "MESSAGE", data: { topic, message: JSON.stringify(inner) } });

test("one raid topic per watched channel, no duplicates", () => {
  assert.deepEqual(channelTopics(["1", "2", "1"]), ["raid.1", "raid.2"]);
  assert.deepEqual(channelTopics([null, "", "  ", 3]), ["raid.3"]);
  assert.deepEqual(channelTopics(null), []);
});

test("an announced raid carries its id and its target", () => {
  const evt = parseFrame(
    message("raid.999", {
      type: "raid_update_v2",
      raid: { id: "raid-1", target_login: "AutreChaine", source_id: "999" },
    }),
  );
  assert.deepEqual(evt, {
    kind: EVENT.RAID,
    raidID: "raid-1",
    sourceChannelId: "999",
    targetLogin: "autrechaine",
  });
});

test("REGRESSION: a raid without an id is unusable", () => {
  // A raid cannot be joined without its id, and Twitch also sends intermediate
  // shapes. Treating those as a raid would fire an empty request.
  const inutilisables = [
    message("raid.999", { type: "raid_update_v2", raid: {} }),
    message("raid.999", { type: "raid_update_v2" }),
    message("raid.999", { type: "raid_go_v2", raid: { id: "raid-1" } }),
    message("raid.999", { type: "raid_cancel_v2", raid: { id: "raid-1" } }),
  ];
  for (const raw of inutilisables) assert.equal(parseFrame(raw).kind, EVENT.UNKNOWN);
});

test("a missing target does not become an empty string", () => {
  const evt = parseFrame(message("raid.999", { type: "raid_update_v2", raid: { id: "r" } }));
  assert.equal(evt.kind, EVENT.RAID);
  assert.equal(evt.targetLogin, null, "null, not the empty string");
});

test("the delta only sends the differences", () => {
  const d = topicDelta(["a", "b"], ["b", "c"]);
  assert.deepEqual(d.listen, ["c"]);
  assert.deepEqual(d.unlisten, ["a"]);
});

test("REGRESSION: changing tab does not cut the account's topics", () => {
  // A global unsubscribe followed by a resubscribe would lose the chests and the
  // tiers on every tab rotation.
  const compte = userTopics("42");
  const avant = [...compte, ...channelTopics(["1"])];
  const apres = [...compte, ...channelTopics(["2"])];

  const d = topicDelta(avant, apres);
  assert.deepEqual(d.listen, ["raid.2"]);
  assert.deepEqual(d.unlisten, ["raid.1"]);
  for (const sujet of compte) {
    assert.equal(d.unlisten.includes(sujet), false, `${sujet} must not be cut`);
  }
});

test("nothing to change sends nothing", () => {
  const d = topicDelta(["a", "b"], ["b", "a"]);
  assert.deepEqual(d.listen, []);
  assert.deepEqual(d.unlisten, []);
});

test("the unsubscribe frame carries no token", () => {
  // The token has no business there: it is only needed to subscribe.
  const frame = unlistenFrame(["raid.1"], "n2");
  assert.equal(frame.type, "UNLISTEN");
  assert.deepEqual(frame.data, { topics: ["raid.1"] });
  assert.equal("auth_token" in frame.data, false);
});
