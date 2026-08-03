// « Actions requises » : les drops qui demandent un geste hors de Twitch
// (lier son compte sur le site de l'éditeur, aller chercher la récompense).
// L'utilisateur les coche dans le popup pour dire « c'est fait ».
// Module pur.

import { needsAccountLink } from "./campaigns.js";

export const ACTION_KIND = {
  LINK: "link", // il faut lier son compte Twitch au site partenaire
  REDEEM: "redeem", // drop récupéré, la récompense s'active sur le site partenaire
};

export function actionId(kind, campaignId, extra = "") {
  return [kind, campaignId, extra].filter(Boolean).join(":");
}

function baseAction(kind, campaign, now, extra = {}) {
  return {
    id: actionId(kind, campaign.id, extra.dropId),
    kind,
    campaignId: campaign.id,
    campaignName: campaign.name,
    game: campaign.gameName,
    url: campaign.accountLinkURL || campaign.detailsURL || "",
    endAt: campaign.endAt ?? null,
    done: false,
    doneAt: null,
    seenAt: now,
    ...extra,
  };
}

/**
 * Fusionne les actions déjà connues avec celles déduites des campagnes.
 * Ne perd jamais l'état « coché » d'une action existante.
 *
 * @returns {{list: Array, added: Array}}
 */
export function buildPendingActions(campaigns, existing = [], now = Date.now()) {
  const byId = new Map(existing.filter(Boolean).map((a) => [a.id, a]));
  const added = [];

  for (const campaign of campaigns || []) {
    if (!campaign?.id) continue;
    if (!needsAccountLink(campaign)) continue;

    const action = baseAction(ACTION_KIND.LINK, campaign, now);
    if (!byId.has(action.id)) {
      byId.set(action.id, action);
      added.push(action);
    }
  }

  return { list: [...byId.values()], added };
}

/**
 * Action créée au moment où un drop est réclamé sur une campagne dont la
 * récompense se récupère sur un site partenaire.
 */
export function redeemAction(campaign, drop, now = Date.now()) {
  if (!campaign?.id || !campaign.accountLinkURL) return null;
  return baseAction(ACTION_KIND.REDEEM, campaign, now, {
    dropId: drop?.id ?? "",
    dropName: drop?.name ?? "",
  });
}

export function addAction(list = [], action) {
  if (!action) return list;
  if (list.some((a) => a.id === action.id)) return list;
  return [...list, action];
}

export function setDone(list = [], id, done = true, now = Date.now()) {
  return list.map((a) =>
    a.id === id ? { ...a, done, doneAt: done ? now : null } : a,
  );
}

export function openActions(list = []) {
  return list.filter((a) => a && !a.done);
}

export function countOpen(list = []) {
  return openActions(list).length;
}

/** Campagnes que l'utilisateur a déclarées liées à la main. */
export function linkedOverrides(list = []) {
  return list
    .filter((a) => a && a.kind === ACTION_KIND.LINK && a.done)
    .map((a) => a.campaignId);
}

/**
 * Nettoyage : on jette les actions cochées de plus de 7 jours et celles dont
 * la campagne est finie depuis plus de 2 jours.
 */
export function pruneActions(list = [], now = Date.now()) {
  const WEEK = 7 * 24 * 60 * 60 * 1000;
  const TWO_DAYS = 2 * 24 * 60 * 60 * 1000;
  return list.filter((a) => {
    if (!a) return false;
    if (a.done && a.doneAt && now - a.doneAt > WEEK) return false;
    if (a.endAt && now - a.endAt > TWO_DAYS) return false;
    return true;
  });
}
