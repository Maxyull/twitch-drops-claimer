// Decides whether a button should be clicked, from a plain descriptor.
// The content script builds these descriptors from the real DOM; everything here
// is pure, and therefore testable without a browser.
//
// A descriptor:
// {
//   text: string,            // the button's label, already trimmed
//   testSelector: string,    // data-test-selector
//   aTarget: string,         // data-a-target
//   ariaLabel: string,
//   context: string,         // text/classes of the parent container (a hint)
//   visible: boolean,
//   disabled: boolean,
// }
//
// The French words in the patterns below are not untranslated text: they are what
// the Twitch interface reads in French, and they are matched literally.

/** Known official selectors for a drop "Claim" button. */
export const DROP_CLAIM_SELECTORS = [
  "DropsCampaignInProgressRewardPresentation-claim-button",
  "drops-claim-button",
  "DropsCampaignInProgressRewardPresentation-claimButton",
];

/** Containers that prove we really are in the Drops area. */
const DROP_CONTEXT_RE =
  /drop|inventaire|inventory|campaign|récompense|recompense|reward/i;

/** Claim labels, French + English. */
const CLAIM_TEXT_RE =
  /^(claim|claim now|claim reward|réclamer|reclamer|récupérer|recuperer|obtenir)$/i;

/**
 * What looks like "Claim" but must NEVER be clicked: subscription offers, Prime,
 * bits, free trials, paid gifts.
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
 * Should this button be clicked to claim a drop?
 * Strategy: official selector first, otherwise an exact label AND a Drops context,
 * and in every case never when the context smells of a commercial offer.
 */
export function isDropClaimButton(d) {
  if (!usable(d)) return false;

  const haystack = `${d.text || ""} ${d.ariaLabel || ""} ${d.context || ""}`;

  if (hasKnownSelector(d)) {
    // The official selector settles it, but a paid offer is still refused.
    return !/prime|abonn|subscri|bits|acheter|buy/i.test(haystack);
  }

  if (!CLAIM_TEXT_RE.test((d.text || "").trim())) return false;
  if (FORBIDDEN_RE.test(haystack)) return false;

  // With no official selector, an explicit Drops context is required.
  return DROP_CONTEXT_RE.test(`${d.context || ""} ${d.ariaLabel || ""}`);
}

/**
 * The purple "channel points bonus" chest.
 *
 * The points container (`community-points-summary`) proves NOTHING: it sits next
 * to the chat at all times, chest or no chest, and the balance button lives there
 * too. Settling for it meant clicking the balance and never reaching the chest.
 * The real marker is `claimable-bonus`, carried by a child of the button, hence
 * reading `inner` on top of the ancestors.
 */
export function isPointsBonusButton(d) {
  if (!usable(d)) return false;

  const markers = `${d.testSelector || ""} ${d.aTarget || ""} ${d.inner || ""} ${d.context || ""}`;
  if (/claimable-bonus/i.test(markers)) return true;

  // Fall back on the accessible label: "Réclamer un bonus", "Claim bonus".
  const label = `${d.ariaLabel || ""} ${d.text || ""}`;
  return /bonus/i.test(label) && /(réclamer|reclamer|récupérer|recuperer|claim)/i.test(label);
}

/** Overlays to dismiss so the player restarts: "still watching?", mature content, ... */
export function isDismissOverlayButton(d) {
  if (!usable(d)) return false;
  const hay = `${d.text || ""} ${d.ariaLabel || ""} ${d.testSelector || ""} ${d.aTarget || ""}`;
  return /toujours là|toujours la|still watching|continuer à regarder|continue watching|start watching|commencer à regarder|player-overlay-mature-accept|content-classification-gate-overlay-start-watching-button|j'ai compris/i.test(
    hay,
  );
}
