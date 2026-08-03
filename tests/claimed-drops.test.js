import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_REMEMBERED,
  collectClaimedIds,
  mergeClaimed,
  trimRemembered,
} from "../src/lib/claimed-drops.js";

function campagne(id, drops) {
  return { id, drops: drops.map(([dropId, isClaimed]) => ({ id: dropId, isClaimed })) };
}

test("ne retient que les paliers marqués obtenus par Twitch", () => {
  const campaigns = [
    campagne("c1", [["d1", true], ["d2", false]]),
    campagne("c2", [["d3", true]]),
  ];
  assert.deepEqual(collectClaimedIds(campaigns), ["d1", "d3"]);
});

test("un palier obtenu sans identifiant est ignoré", () => {
  const campaigns = [{ id: "c1", drops: [{ id: "", isClaimed: true }, { isClaimed: true }] }];
  assert.deepEqual(collectClaimedIds(campaigns), []);
});

test("entrées vides ou mal formées", () => {
  assert.deepEqual(collectClaimedIds(null), []);
  assert.deepEqual(collectClaimedIds([null, {}, { drops: null }]), []);
});

test("RÉGRESSION : le premier passage n'affiche pas l'historique du compte", () => {
  // Sans cette prise d'empreinte, le compteur sauterait de 0 à « tous les drops
  // jamais obtenus » dès la première recherche, ce qui ne veut rien dire.
  const campaigns = [campagne("c1", [["d1", true], ["d2", true]])];
  const first = mergeClaimed([], false, campaigns);

  assert.deepEqual(first.added, [], "rien n'est compté au premier passage");
  assert.deepEqual(first.ids.sort(), ["d1", "d2"], "mais tout est mémorisé");
});

test("après l'empreinte, seuls les nouveaux paliers comptent", () => {
  const avant = [campagne("c1", [["d1", true]])];
  const { ids } = mergeClaimed([], false, avant);

  const apres = [campagne("c1", [["d1", true], ["d2", true]])];
  const suite = mergeClaimed(ids, true, apres);

  assert.deepEqual(suite.added, ["d2"]);
  assert.equal(suite.ids.length, 2);
});

test("relire deux fois la même chose ne compte pas deux fois", () => {
  const campaigns = [campagne("c1", [["d1", true]])];
  const un = mergeClaimed(["d0"], true, campaigns);
  assert.deepEqual(un.added, ["d1"]);

  const deux = mergeClaimed(un.ids, true, campaigns);
  assert.deepEqual(deux.added, [], "aucun doublon au passage suivant");
  assert.equal(deux.ids.length, 2);
});

test("un palier qui repasse à non réclamé ne retire rien", () => {
  // Twitch peut renvoyer une campagne allégée : ce n'est pas une raison pour
  // faire redescendre un compteur.
  const connu = mergeClaimed([], true, [campagne("c1", [["d1", true]])]).ids;
  const apres = mergeClaimed(connu, true, [campagne("c1", [["d1", false]])]);
  assert.deepEqual(apres.ids, ["d1"]);
  assert.deepEqual(apres.added, []);
});

test("RÉGRESSION : un état de reclamation périmé ne doit jamais compter", () => {
  // Le cache de structure des campagnes remettait `isClaimed` à ce qu'il était
  // six heures plus tôt. Un palier réclamé entre-temps devenait invisible, et le
  // compteur restait à zéro. On simule les deux lectures dans le désordre.
  const frais = [campagne("c1", [["d1", true]])];
  const perime = [campagne("c1", [["d1", false]])];

  const apresFrais = mergeClaimed([], true, frais);
  assert.deepEqual(apresFrais.added, ["d1"]);

  // Une lecture périmée ne doit ni retirer, ni permettre de recompter ensuite.
  const apresPerime = mergeClaimed(apresFrais.ids, true, perime);
  assert.deepEqual(apresPerime.added, []);
  assert.deepEqual(mergeClaimed(apresPerime.ids, true, frais).added, []);
});

test("l'historique mémorisé est borné, en gardant les plus récents", () => {
  const beaucoup = Array.from({ length: MAX_REMEMBERED + 50 }, (_, i) => `d${i}`);
  const coupe = trimRemembered(beaucoup);
  assert.equal(coupe.length, MAX_REMEMBERED);
  assert.equal(coupe.at(-1), `d${MAX_REMEMBERED + 49}`);
  assert.deepEqual(trimRemembered(["a", "b"], 5), ["a", "b"]);
  assert.deepEqual(trimRemembered(null), []);
});
