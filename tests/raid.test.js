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

test("un sujet de raid par chaîne regardée, sans doublon", () => {
  assert.deepEqual(channelTopics(["1", "2", "1"]), ["raid.1", "raid.2"]);
  assert.deepEqual(channelTopics([null, "", "  ", 3]), ["raid.3"]);
  assert.deepEqual(channelTopics(null), []);
});

test("un raid annoncé porte son identifiant et sa cible", () => {
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

test("RÉGRESSION : un raid sans identifiant n'est pas exploitable", () => {
  // On ne peut pas rejoindre un raid sans son identifiant, et Twitch envoie
  // aussi des formes intermédiaires. Les traiter comme un raid ferait partir
  // une requête vide.
  const inutilisables = [
    message("raid.999", { type: "raid_update_v2", raid: {} }),
    message("raid.999", { type: "raid_update_v2" }),
    message("raid.999", { type: "raid_go_v2", raid: { id: "raid-1" } }),
    message("raid.999", { type: "raid_cancel_v2", raid: { id: "raid-1" } }),
  ];
  for (const raw of inutilisables) assert.equal(parseFrame(raw).kind, EVENT.UNKNOWN);
});

test("une cible absente ne devient pas une chaîne vide", () => {
  const evt = parseFrame(message("raid.999", { type: "raid_update_v2", raid: { id: "r" } }));
  assert.equal(evt.kind, EVENT.RAID);
  assert.equal(evt.targetLogin, null, "null, pas la chaîne vide");
});

test("le delta n'envoie que les différences", () => {
  const d = topicDelta(["a", "b"], ["b", "c"]);
  assert.deepEqual(d.listen, ["c"]);
  assert.deepEqual(d.unlisten, ["a"]);
});

test("RÉGRESSION : changer d'onglet ne coupe pas les sujets du compte", () => {
  // Un désabonnement global suivi d'un réabonnement ferait perdre les coffres
  // et les paliers à chaque rotation d'onglet.
  const compte = userTopics("42");
  const avant = [...compte, ...channelTopics(["1"])];
  const apres = [...compte, ...channelTopics(["2"])];

  const d = topicDelta(avant, apres);
  assert.deepEqual(d.listen, ["raid.2"]);
  assert.deepEqual(d.unlisten, ["raid.1"]);
  for (const sujet of compte) {
    assert.equal(d.unlisten.includes(sujet), false, `${sujet} ne doit pas être coupé`);
  }
});

test("rien à changer n'envoie rien", () => {
  const d = topicDelta(["a", "b"], ["b", "a"]);
  assert.deepEqual(d.listen, []);
  assert.deepEqual(d.unlisten, []);
});

test("la trame de désabonnement ne porte pas de jeton", () => {
  // Le jeton n'a rien à faire là : il n'est utile qu'à l'abonnement.
  const frame = unlistenFrame(["raid.1"], "n2");
  assert.equal(frame.type, "UNLISTEN");
  assert.deepEqual(frame.data, { topics: ["raid.1"] });
  assert.equal("auth_token" in frame.data, false);
});
