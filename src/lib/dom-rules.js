// Décide s'il faut cliquer un bouton, à partir d'un simple descripteur.
// Le script de contenu construit ces descripteurs depuis le vrai DOM ; ici
// tout est pur, donc testable sans navigateur.
//
// Un descripteur :
// {
//   text: string,            // libellé du bouton, déjà trimé
//   testSelector: string,    // data-test-selector
//   aTarget: string,         // data-a-target
//   ariaLabel: string,
//   context: string,         // texte/classes du conteneur parent (indice)
//   visible: boolean,
//   disabled: boolean,
// }

/** Sélecteurs officiels connus d'un bouton « Réclamer » de drop. */
export const DROP_CLAIM_SELECTORS = [
  "DropsCampaignInProgressRewardPresentation-claim-button",
  "drops-claim-button",
  "DropsCampaignInProgressRewardPresentation-claimButton",
];

/** Conteneurs qui prouvent qu'on est bien dans la zone Drops. */
const DROP_CONTEXT_RE =
  /drop|inventaire|inventory|campaign|récompense|recompense|reward/i;

/** Libellés de réclamation, FR + EN. */
const CLAIM_TEXT_RE =
  /^(claim|claim now|claim reward|réclamer|reclamer|récupérer|recuperer|obtenir)$/i;

/**
 * Ce qui ressemble à « Réclamer » mais qu'il ne faut JAMAIS cliquer :
 * offres d'abonnement, Prime, bits, essais gratuits, cadeaux payants.
 */
const FORBIDDEN_RE =
  /prime|abonn|s'abonner|subscri|sub\b|gift|cadeau|offert|bits|essai|trial|crédit|credit|acheter|buy|upgrade|turbo/i;

function usable(d) {
  return Boolean(d) && d.visible === true && d.disabled !== true;
}

function hasKnownSelector(d) {
  const sel = `${d.testSelector || ""} ${d.aTarget || ""}`;
  return DROP_CLAIM_SELECTORS.some((known) => sel.includes(known));
}

/**
 * Faut-il cliquer ce bouton pour réclamer un drop ?
 * Stratégie : sélecteur officiel d'abord, sinon libellé exact ET contexte Drops,
 * et dans tous les cas jamais si le contexte sent l'offre commerciale.
 */
export function isDropClaimButton(d) {
  if (!usable(d)) return false;

  const haystack = `${d.text || ""} ${d.ariaLabel || ""} ${d.context || ""}`;

  if (hasKnownSelector(d)) {
    // Le sélecteur officiel fait foi, mais on refuse quand même une offre payante.
    return !/prime|abonn|subscri|bits|acheter|buy/i.test(haystack);
  }

  if (!CLAIM_TEXT_RE.test((d.text || "").trim())) return false;
  if (FORBIDDEN_RE.test(haystack)) return false;

  // Sans sélecteur officiel, on exige un contexte Drops explicite.
  return DROP_CONTEXT_RE.test(`${d.context || ""} ${d.ariaLabel || ""}`);
}

/**
 * Coffre violet « bonus de points de chaîne ».
 *
 * Le conteneur des points (`community-points-summary`) ne prouve RIEN : il est
 * toujours présent à côté du chat, coffre ou pas, et le bouton du solde s'y
 * trouve aussi. S'en contenter revenait à cliquer le solde et à ne jamais
 * atteindre le coffre.
 * Le vrai marqueur est `claimable-bonus`, porté par un enfant du bouton, d'où
 * la lecture de `inner` en plus des ancêtres.
 */
export function isPointsBonusButton(d) {
  if (!usable(d)) return false;

  const markers = `${d.testSelector || ""} ${d.aTarget || ""} ${d.inner || ""} ${d.context || ""}`;
  if (/claimable-bonus/i.test(markers)) return true;

  // Repli sur le libellé accessible : « Réclamer un bonus », « Claim bonus ».
  const label = `${d.ariaLabel || ""} ${d.text || ""}`;
  return /bonus/i.test(label) && /(réclamer|reclamer|récupérer|recuperer|claim)/i.test(label);
}

/** Bandeaux à écarter pour que le lecteur reparte : « toujours là ? », contenu sensible… */
export function isDismissOverlayButton(d) {
  if (!usable(d)) return false;
  const hay = `${d.text || ""} ${d.ariaLabel || ""} ${d.testSelector || ""} ${d.aTarget || ""}`;
  return /toujours là|toujours la|still watching|continuer à regarder|continue watching|start watching|commencer à regarder|player-overlay-mature-accept|content-classification-gate-overlay-start-watching-button|j'ai compris/i.test(
    hay,
  );
}
