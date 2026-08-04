import test from "node:test";
import assert from "node:assert/strict";

import { applyLiveSession, campaignProgress } from "../src/lib/campaigns.js";

const drop = (id, required, watched) => ({
  id,
  name: id,
  requiredMinutes: required,
  watchedMinutes: watched,
  isClaimed: false,
  dropInstanceID: null,
  benefits: [],
});

const campagne = (id, drops) => ({ id, name: id, gameName: "Jeu", channels: [], drops });

test("la session en direct fait monter le palier concerné", () => {
  const stockees = [campagne("c1", [drop("d1", 60, 12), drop("d2", 120, 12)])];

  const res = applyLiveSession(stockees, { dropID: "d1", watchedMinutes: 19 });
  assert.equal(res.changed, true);
  assert.equal(res.campaigns[0].drops[0].watchedMinutes, 19);
  assert.equal(res.campaigns[0].drops[1].watchedMinutes, 12, "les autres paliers ne bougent pas");
});

test("RÉGRESSION : un compteur ne recule jamais", () => {
  // L'inventaire et la session en direct ne se rafraîchissent pas au même
  // rythme. Une valeur plus vieille qui arrive après une plus récente ferait
  // redescendre la barre sous les yeux de l'utilisateur.
  const stockees = [campagne("c1", [drop("d1", 60, 40)])];

  const res = applyLiveSession(stockees, { dropID: "d1", watchedMinutes: 35 });
  assert.equal(res.changed, false);
  assert.equal(res.campaigns[0].drops[0].watchedMinutes, 40);
  assert.equal(res.campaigns[0], stockees[0], "aucune copie non plus");
});

test("une valeur identique n'écrit rien", () => {
  // L'appel tourne chaque minute alors que Twitch compte par minute entière :
  // la plupart des passages ne changent rien.
  const stockees = [campagne("c1", [drop("d1", 60, 40)])];
  const res = applyLiveSession(stockees, { dropID: "d1", watchedMinutes: 40 });
  assert.equal(res.changed, false);
});

test("un palier inconnu ne crée rien", () => {
  const stockees = [campagne("c1", [drop("d1", 60, 40)])];
  const res = applyLiveSession(stockees, { dropID: "inconnu", watchedMinutes: 99 });
  assert.equal(res.changed, false);
  assert.equal(res.campaigns[0].drops.length, 1);
});

test("une session vide ou illisible ne touche à rien", () => {
  const stockees = [campagne("c1", [drop("d1", 60, 40)])];

  for (const session of [null, undefined, {}, { dropID: "d1" }, { dropID: "d1", watchedMinutes: "x" }]) {
    const res = applyLiveSession(stockees, session);
    assert.equal(res.changed, false, JSON.stringify(session));
    assert.equal(res.campaigns[0].drops[0].watchedMinutes, 40);
  }
});

test("la barre suit vraiment", () => {
  const stockees = [campagne("c1", [drop("d1", 60, 0)])];
  assert.equal(campaignProgress(stockees[0]).pct, 0);

  const res = applyLiveSession(stockees, { dropID: "d1", watchedMinutes: 30 });
  assert.equal(campaignProgress(res.campaigns[0]).pct, 50);
  assert.equal(campaignProgress(res.campaigns[0]).remainingMinutes, 30);
});

test("aucune campagne stockée : pas d'erreur", () => {
  assert.deepEqual(applyLiveSession([], { dropID: "d1", watchedMinutes: 3 }), {
    campaigns: [],
    changed: false,
  });
  assert.deepEqual(applyLiveSession(null, null), { campaigns: [], changed: false });
});
