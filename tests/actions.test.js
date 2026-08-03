import test from "node:test";
import assert from "node:assert/strict";

import {
  ACTION_KIND,
  buildPendingActions,
  redeemAction,
  addAction,
  setDone,
  openActions,
  countOpen,
  linkedOverrides,
  pruneActions,
} from "../src/lib/actions.js";
import { parseCampaign } from "../src/lib/campaigns.js";
import { campaignNode, unlinkedCampaignNode, DAY } from "./fixtures.js";

// Les fixtures datent les campagnes par rapport à maintenant : on aligne.
const NOW = Date.now();

test("buildPendingActions ne signale que les comptes non liés", () => {
  const campaigns = [parseCampaign(campaignNode()), parseCampaign(unlinkedCampaignNode())];
  const { list, added } = buildPendingActions(campaigns, [], NOW);
  assert.equal(list.length, 1);
  assert.equal(added.length, 1);
  assert.equal(list[0].kind, ACTION_KIND.LINK);
  assert.equal(list[0].campaignId, "camp-non-liee");
  assert.equal(list[0].url, "https://editeur.example/link");
  assert.equal(list[0].done, false);
});

test("buildPendingActions ne perd jamais une case déjà cochée", () => {
  const campaigns = [parseCampaign(unlinkedCampaignNode())];
  const first = buildPendingActions(campaigns, [], NOW).list;
  const checked = setDone(first, first[0].id, true, NOW);

  const second = buildPendingActions(campaigns, checked, NOW + DAY);
  assert.equal(second.list.length, 1);
  assert.equal(second.list[0].done, true, "la campagne réapparaît, la case reste cochée");
  assert.equal(second.added.length, 0, "pas de nouvelle notification");
});

test("redeemAction n'existe que pour une campagne à site partenaire", () => {
  const withLink = parseCampaign(unlinkedCampaignNode());
  const plain = parseCampaign(campaignNode());
  const drop = withLink.drops[0];

  const action = redeemAction(withLink, drop, NOW);
  assert.equal(action.kind, ACTION_KIND.REDEEM);
  assert.equal(action.dropName, drop.name);
  assert.equal(redeemAction(plain, drop, NOW), null);
  assert.equal(redeemAction(null, drop, NOW), null);
});

test("addAction ignore les doublons", () => {
  const campaign = parseCampaign(unlinkedCampaignNode());
  const action = redeemAction(campaign, campaign.drops[0], NOW);
  const once = addAction([], action);
  assert.equal(addAction(once, action).length, 1);
  assert.equal(addAction(once, null).length, 1);
});

test("une action lien et une action récupération coexistent", () => {
  const campaign = parseCampaign(unlinkedCampaignNode());
  const { list } = buildPendingActions([campaign], [], NOW);
  const full = addAction(list, redeemAction(campaign, campaign.drops[0], NOW));
  assert.equal(full.length, 2);
  assert.equal(new Set(full.map((a) => a.id)).size, 2);
});

test("setDone bascule dans les deux sens et horodate", () => {
  const campaign = parseCampaign(unlinkedCampaignNode());
  const { list } = buildPendingActions([campaign], [], NOW);
  const done = setDone(list, list[0].id, true, NOW);
  assert.equal(done[0].done, true);
  assert.equal(done[0].doneAt, NOW);

  const undone = setDone(done, list[0].id, false, NOW);
  assert.equal(undone[0].done, false);
  assert.equal(undone[0].doneAt, null);
});

test("compteurs et surcharges de liaison", () => {
  const campaign = parseCampaign(unlinkedCampaignNode());
  const { list } = buildPendingActions([campaign], [], NOW);
  assert.equal(countOpen(list), 1);
  assert.deepEqual(linkedOverrides(list), []);

  const done = setDone(list, list[0].id, true, NOW);
  assert.equal(countOpen(done), 0);
  assert.equal(openActions(done).length, 0);
  assert.deepEqual(linkedOverrides(done), ["camp-non-liee"]);
});

test("linkedOverrides ignore les actions de type récupération", () => {
  const campaign = parseCampaign(unlinkedCampaignNode());
  const redeem = redeemAction(campaign, campaign.drops[0], NOW);
  const list = setDone(addAction([], redeem), redeem.id, true, NOW);
  assert.deepEqual(linkedOverrides(list), []);
});

test("pruneActions nettoie le vieux et garde ce qui est à faire", () => {
  const campaign = parseCampaign(unlinkedCampaignNode());
  const { list } = buildPendingActions([campaign], [], NOW);
  const done = setDone(list, list[0].id, true, NOW - 8 * DAY);

  assert.equal(pruneActions(done, NOW).length, 0, "cochée depuis plus d'une semaine");
  assert.equal(pruneActions(list, NOW).length, 1, "pas cochée, on garde");

  const expired = [{ ...list[0], endAt: NOW - 3 * DAY }];
  assert.equal(pruneActions(expired, NOW).length, 0, "campagne finie depuis longtemps");
  assert.deepEqual(pruneActions([null, undefined], NOW), []);
});
