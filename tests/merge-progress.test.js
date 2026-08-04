import test from "node:test";
import assert from "node:assert/strict";

import { campaignProgress, mergeProgress } from "../src/lib/campaigns.js";

const drop = (id, required, watched, extra = {}) => ({
  id,
  name: id,
  requiredMinutes: required,
  watchedMinutes: watched,
  isClaimed: false,
  dropInstanceID: null,
  benefits: [],
  ...extra,
});

const campagne = (id, drops, extra = {}) => ({
  id,
  name: id,
  gameName: "Jeu",
  channels: [{ id: "1", login: "quelquun", displayName: "QuelquUn" }],
  drops,
  ...extra,
});

test("l'avancement frais remonte dans les campagnes stockées", () => {
  const stockees = [campagne("c1", [drop("d1", 60, 10)])];
  const frais = [campagne("c1", [drop("d1", 60, 35)])];

  const res = mergeProgress(stockees, frais);
  assert.equal(res.changed, true);
  assert.equal(res.campaigns[0].drops[0].watchedMinutes, 35);
  assert.equal(campaignProgress(res.campaigns[0]).pct, 58, "la barre bouge");
});

test("RÉGRESSION : la structure ne suit pas l'avancement", () => {
  // L'inventaire ne porte ni les chaînes autorisées ni les récompenses de la
  // même façon que le détail de campagne. Recopier la structure ferait perdre
  // ce qui a coûté cher à obtenir.
  const stockees = [
    campagne("c1", [drop("d1", 60, 0, { benefits: [{ id: "b", name: "Casque", imageURL: "" }] })]),
  ];
  const frais = [campagne("c1", [drop("d1", 60, 12)], { channels: [], name: "" })];

  const res = mergeProgress(stockees, frais);
  const fusionnee = res.campaigns[0];
  assert.equal(fusionnee.drops[0].watchedMinutes, 12);
  assert.deepEqual(fusionnee.drops[0].benefits, [{ id: "b", name: "Casque", imageURL: "" }]);
  assert.equal(fusionnee.channels.length, 1);
  assert.equal(fusionnee.name, "c1");
});

test("un palier devenu réclamable ou réclamé remonte aussi", () => {
  const stockees = [campagne("c1", [drop("d1", 60, 59)])];
  const frais = [campagne("c1", [drop("d1", 60, 60, { dropInstanceID: "inst" })])];

  const res = mergeProgress(stockees, frais);
  assert.equal(res.campaigns[0].drops[0].dropInstanceID, "inst");
  assert.equal(campaignProgress(res.campaigns[0]).claimable, 1);
});

test("RÉGRESSION : une campagne absente de l'inventaire garde son avancement", () => {
  // L'inventaire ne liste que ce à quoi le compte participe. Une absence n'est
  // pas une remise à zéro, sinon la barre retomberait à chaque passage.
  const stockees = [campagne("c1", [drop("d1", 60, 40)]), campagne("c2", [drop("d2", 30, 10)])];
  const frais = [campagne("c1", [drop("d1", 60, 45)])];

  const res = mergeProgress(stockees, frais);
  assert.equal(res.campaigns[0].drops[0].watchedMinutes, 45);
  assert.equal(res.campaigns[1].drops[0].watchedMinutes, 10, "intacte, pas remise à zéro");
});

test("un palier inconnu de l'inventaire reste tel quel", () => {
  const stockees = [campagne("c1", [drop("d1", 60, 40), drop("d2", 120, 40)])];
  const frais = [campagne("c1", [drop("d1", 60, 55)])];

  const res = mergeProgress(stockees, frais);
  assert.equal(res.campaigns[0].drops[0].watchedMinutes, 55);
  assert.equal(res.campaigns[0].drops[1].watchedMinutes, 40);
});

test("rien de neuf n'écrit rien", () => {
  // L'appel tourne toutes les 5 minutes : réécrire des campagnes identiques
  // userait le quota de stockage pour rien.
  const stockees = [campagne("c1", [drop("d1", 60, 40)])];
  const frais = [campagne("c1", [drop("d1", 60, 40)])];

  const res = mergeProgress(stockees, frais);
  assert.equal(res.changed, false);
  assert.equal(res.campaigns[0], stockees[0], "le même objet, aucune copie");
});

test("un inventaire vide ou illisible ne touche à rien", () => {
  const stockees = [campagne("c1", [drop("d1", 60, 40)])];

  for (const frais of [[], null, undefined, [null]]) {
    const res = mergeProgress(stockees, frais);
    assert.equal(res.changed, false);
    assert.equal(res.campaigns[0].drops[0].watchedMinutes, 40);
  }
});

test("aucune campagne stockée : rien à fusionner, pas d'erreur", () => {
  const res = mergeProgress([], [campagne("c1", [drop("d1", 60, 5)])]);
  assert.deepEqual(res, { campaigns: [], changed: false });
  assert.deepEqual(mergeProgress(null, null), { campaigns: [], changed: false });
});
