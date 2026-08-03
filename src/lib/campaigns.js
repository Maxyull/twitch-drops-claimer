// Modèle de campagne de drops : lecture des réponses GQL, progression, classement.
// Module pur (aucune API chrome, aucun fetch) pour rester testable sous Node.

export const DROP_STATE = {
  CLAIMED: "claimed", // déjà récupéré
  CLAIMABLE: "claimable", // temps atteint, bouton dispo
  IN_PROGRESS: "inProgress", // temps en cours d'accumulation
  TODO: "todo", // rien de regardé
};

function ms(value) {
  if (!value) return null;
  const t = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Noeud GQL `DropCampaign` -> modèle interne, tolérant aux champs manquants. */
export function parseCampaign(node) {
  if (!node || !node.id) return null;

  const drops = (node.timeBasedDrops || []).map((d) => ({
    id: d?.id ?? "",
    name: d?.name ?? "",
    requiredMinutes: num(d?.requiredMinutesWatched),
    watchedMinutes: num(d?.self?.currentMinutesWatched),
    isClaimed: Boolean(d?.self?.isClaimed),
    dropInstanceID: d?.self?.dropInstanceID ?? null,
    benefits: (d?.benefitEdges || [])
      .map((e) => e?.benefit)
      .filter(Boolean)
      .map((b) => ({ id: b.id, name: b.name ?? "", imageURL: b.imageAssetURL ?? "" })),
  }));

  return {
    id: node.id,
    name: node.name ?? "",
    status: node.status ?? "",
    startAt: ms(node.startAt),
    endAt: ms(node.endAt),
    gameId: node.game?.id ?? "",
    gameName: node.game?.displayName ?? "",
    gameSlug: node.game?.slug ?? "",
    detailsURL: node.detailsURL ?? "",
    accountLinkURL: node.accountLinkURL ?? "",
    // `null` = information absente de cette requête, à ne pas confondre avec `false`.
    isAccountConnected:
      typeof node.self?.isAccountConnected === "boolean" ? node.self.isAccountConnected : null,
    channels: (node.allow?.channels || [])
      .filter(Boolean)
      .map((c) => ({ id: c.id ?? "", login: (c.name ?? "").toLowerCase(), displayName: c.displayName ?? c.name ?? "" }))
      .filter((c) => c.login),
    drops,
  };
}

export function parseCampaigns(nodes) {
  return (nodes || []).map(parseCampaign).filter(Boolean);
}

export function dropState(drop) {
  if (!drop) return DROP_STATE.TODO;
  if (drop.isClaimed) return DROP_STATE.CLAIMED;
  if (drop.dropInstanceID) return DROP_STATE.CLAIMABLE;
  if (drop.watchedMinutes >= drop.requiredMinutes && drop.requiredMinutes > 0) {
    return DROP_STATE.CLAIMABLE;
  }
  return drop.watchedMinutes > 0 ? DROP_STATE.IN_PROGRESS : DROP_STATE.TODO;
}

/**
 * Progression d'une campagne.
 * `remainingMinutes` = temps restant sur le PROCHAIN palier non obtenu,
 * c'est ce qui sert à classer « le plus proche de la fin ».
 */
export function campaignProgress(campaign) {
  const drops = campaign?.drops || [];
  let required = 0;
  let watched = 0;
  let claimable = 0;
  let claimed = 0;

  for (const d of drops) {
    required += d.requiredMinutes;
    watched += Math.min(d.watchedMinutes, d.requiredMinutes);
    const st = dropState(d);
    if (st === DROP_STATE.CLAIMABLE) claimable += 1;
    if (st === DROP_STATE.CLAIMED) claimed += 1;
  }

  const next = nextDrop(campaign);
  const remainingMinutes = next
    ? Math.max(0, next.requiredMinutes - next.watchedMinutes)
    : 0;

  return {
    total: drops.length,
    claimed,
    claimable,
    required,
    watched,
    pct: required > 0 ? Math.min(100, Math.round((watched / required) * 100)) : 0,
    remainingMinutes,
    done: drops.length > 0 && claimed === drops.length,
  };
}

/** Prochain palier à travailler (non réclamé, pas encore réclamable), le plus court d'abord. */
export function nextDrop(campaign) {
  const pending = (campaign?.drops || [])
    .filter((d) => dropState(d) === DROP_STATE.IN_PROGRESS || dropState(d) === DROP_STATE.TODO)
    .sort((a, b) => a.requiredMinutes - b.requiredMinutes);
  return pending[0] || null;
}

/** Paliers prêts à être réclamés. */
export function claimableDrops(campaign) {
  return (campaign?.drops || []).filter((d) => dropState(d) === DROP_STATE.CLAIMABLE);
}

/** La campagne exige-t-elle de lier son compte sur un site partenaire ? */
export function needsAccountLink(campaign) {
  return Boolean(campaign?.accountLinkURL) && campaign.isAccountConnected === false;
}

export function isActive(campaign, now = Date.now()) {
  if (!campaign) return false;
  if (campaign.status && campaign.status !== "ACTIVE") return false;
  if (campaign.startAt && now < campaign.startAt) return false;
  if (campaign.endAt && now >= campaign.endAt) return false;
  return true;
}

/**
 * Classe les campagnes à farmer, de la plus prioritaire à la moins prioritaire.
 * Écarte : inactives, terminées, sur liste noire, et (si demandé) celles dont le
 * compte n'est pas lié, sauf si l'utilisateur a coché « c'est fait » (linkedOverrides).
 */
export function rankCampaigns(campaigns, options = {}) {
  const {
    now = Date.now(),
    strategy = "endingSoon",
    blacklist = [],
    linkedOverrides = [],
    onlyLinkedCampaigns = false,
  } = options;

  const blocked = new Set(blacklist);
  const overridden = new Set(linkedOverrides);

  const eligible = (campaigns || []).filter((c) => {
    if (!c || blocked.has(c.id)) return false;
    if (!isActive(c, now)) return false;
    if (campaignProgress(c).done) return false;
    if (!nextDrop(c)) return false; // plus rien à accumuler
    if (onlyLinkedCampaigns && needsAccountLink(c) && !overridden.has(c.id)) return false;
    return true;
  });

  const order = new Map(eligible.map((c, i) => [c.id, i]));

  return eligible.slice().sort((a, b) => {
    if (strategy === "order") return order.get(a.id) - order.get(b.id);

    if (strategy === "closestToDone") {
      const d = campaignProgress(a).remainingMinutes - campaignProgress(b).remainingMinutes;
      if (d !== 0) return d;
    }

    // Par défaut (et en départage) : ce qui expire le plus tôt.
    const ea = a.endAt ?? Number.MAX_SAFE_INTEGER;
    const eb = b.endAt ?? Number.MAX_SAFE_INTEGER;
    if (ea !== eb) return ea - eb;

    const ra = campaignProgress(a).remainingMinutes;
    const rb = campaignProgress(b).remainingMinutes;
    if (ra !== rb) return ra - rb;

    return order.get(a.id) - order.get(b.id);
  });
}

/**
 * Choisit la chaîne à regarder pour une campagne.
 * - liste blanche de chaînes -> la première qui est en live
 * - pas de liste blanche -> null, l'appelant ira chercher un live dans la catégorie
 */
export function pickChannel(campaign, liveLogins = []) {
  const live = new Set(liveLogins.map((l) => String(l).toLowerCase()));
  const allowed = campaign?.channels || [];
  if (!allowed.length) return null;
  const hit = allowed.find((c) => live.has(c.login));
  return hit ? hit.login : null;
}

/** true si la campagne accepte n'importe quel live de la catégorie. */
export function isCategoryWide(campaign) {
  return !(campaign?.channels || []).length;
}
