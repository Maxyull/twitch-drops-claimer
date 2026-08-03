import test from "node:test";
import assert from "node:assert/strict";

import {
  isDropClaimButton,
  isPointsBonusButton,
  isDismissOverlayButton,
  DROP_CLAIM_SELECTORS,
} from "../src/lib/dom-rules.js";

function btn(overrides = {}) {
  return {
    text: "",
    testSelector: "",
    aTarget: "",
    ariaLabel: "",
    inner: "",
    context: "/directory",
    visible: true,
    disabled: false,
    ...overrides,
  };
}

/** Le bouton du solde, toujours présent à côté du chat, coffre ou pas. */
const SOLDE_DE_POINTS = btn({
  text: "1 234",
  aTarget: "community-points-summary",
  ariaLabel: "Points de chaîne",
  context: "/zerator community-points-summary tw-flex",
});

/** Le coffre : sa classe est portée par une icône À L'INTÉRIEUR du bouton. */
const COFFRE = btn({
  ariaLabel: "Réclamer un bonus",
  inner: "claimable-bonus__icon tw-svg",
  context: "/zerator community-points-summary",
});

const INVENTORY_CTX = "/drops/inventory drops-campaign-in-progress tw-tower";

test("clique le bouton officiel de réclamation d'un drop", () => {
  assert.equal(
    isDropClaimButton(btn({ testSelector: DROP_CLAIM_SELECTORS[0], text: "Réclamer", context: INVENTORY_CTX })),
    true,
  );
});

test("repli sur le libellé, mais seulement dans un contexte Drops", () => {
  assert.equal(isDropClaimButton(btn({ text: "Réclamer", context: INVENTORY_CTX })), true);
  assert.equal(isDropClaimButton(btn({ text: "Claim", context: INVENTORY_CTX })), true);
  assert.equal(isDropClaimButton(btn({ text: "Récupérer", context: INVENTORY_CTX })), true);
  // Même libellé, mais rien ne prouve qu'on est dans les drops : on ne touche pas.
  assert.equal(isDropClaimButton(btn({ text: "Réclamer", context: "/zerator sidebar" })), false);
});

test("RÉGRESSION : ne clique jamais une offre commerciale", () => {
  const pieges = [
    btn({ text: "Réclamer", context: "/zerator prime-offer-card drop-shadow" }),
    btn({ text: "Réclamer", context: `${INVENTORY_CTX} prime-subscription-offer` }),
    btn({ text: "Claim", context: `${INVENTORY_CTX} gift-a-sub` }),
    btn({ text: "Réclamer", context: `${INVENTORY_CTX} bits-offer` }),
    btn({ text: "Réclamer", ariaLabel: "Réclamer votre essai gratuit", context: INVENTORY_CTX }),
    btn({ text: "S'abonner", context: INVENTORY_CTX }),
    btn({ text: "Acheter", context: INVENTORY_CTX }),
  ];
  for (const b of pieges) {
    assert.equal(isDropClaimButton(b), false, `cliqué à tort : ${b.text} / ${b.context}`);
  }
});

test("RÉGRESSION : même avec le sélecteur officiel, une offre Prime est refusée", () => {
  assert.equal(
    isDropClaimButton(
      btn({ testSelector: DROP_CLAIM_SELECTORS[0], text: "Réclamer", context: "prime-offer" }),
    ),
    false,
  );
});

test("un bouton invisible ou désactivé n'est jamais cliqué", () => {
  const base = { testSelector: DROP_CLAIM_SELECTORS[0], text: "Réclamer", context: INVENTORY_CTX };
  assert.equal(isDropClaimButton(btn({ ...base, visible: false })), false);
  assert.equal(isDropClaimButton(btn({ ...base, disabled: true })), false);
  assert.equal(isDropClaimButton(null), false);
});

test("un libellé approchant ne suffit pas", () => {
  assert.equal(isDropClaimButton(btn({ text: "Réclamer plus tard", context: INVENTORY_CTX })), false);
  assert.equal(isDropClaimButton(btn({ text: "", context: INVENTORY_CTX })), false);
});

test("coffre de points de chaîne", () => {
  assert.equal(isPointsBonusButton(COFFRE), true, "marqueur porté par un enfant du bouton");
  assert.equal(isPointsBonusButton(btn({ context: "claimable-bonus__icon" })), true);
  assert.equal(isPointsBonusButton(btn({ testSelector: "claimable-bonus" })), true);
  assert.equal(isPointsBonusButton(btn({ ariaLabel: "Claim your bonus" })), true);
  assert.equal(isPointsBonusButton({ ...COFFRE, visible: false }), false);
  assert.equal(isPointsBonusButton({ ...COFFRE, disabled: true }), false);
});

test("RÉGRESSION : le bouton du solde de points n'est pas le coffre", () => {
  // Il est TOUJOURS là, coffre ou pas. Le reconnaître revenait à cliquer le
  // solde, à ouvrir le menu des points, et à ne jamais atteindre le coffre,
  // tout en rapportant une réclamation qui n'avait pas eu lieu.
  assert.equal(isPointsBonusButton(SOLDE_DE_POINTS), false);
});

test("RÉGRESSION : le conteneur des points ne suffit pas à lui seul", () => {
  const voisins = [
    btn({ context: "community-points-summary", text: "Voir les récompenses" }),
    btn({ aTarget: "community-points-summary", ariaLabel: "Ouvrir le menu" }),
    btn({ context: "community-points-summary", ariaLabel: "Bonus" }), // « bonus » sans verbe
  ];
  for (const b of voisins) {
    assert.equal(isPointsBonusButton(b), false, `cliqué à tort : ${b.ariaLabel || b.text}`);
  }
});

test("bandeaux à écarter pour relancer le lecteur", () => {
  assert.equal(isDismissOverlayButton(btn({ text: "Vous êtes toujours là ?" })), true);
  assert.equal(isDismissOverlayButton(btn({ text: "Continuer à regarder" })), true);
  assert.equal(isDismissOverlayButton(btn({ text: "Still watching" })), true);
  assert.equal(
    isDismissOverlayButton(btn({ aTarget: "player-overlay-mature-accept", text: "Commencer à regarder" })),
    true,
  );
  assert.equal(
    isDismissOverlayButton(
      btn({ aTarget: "content-classification-gate-overlay-start-watching-button" }),
    ),
    true,
  );
  assert.equal(isDismissOverlayButton(btn({ text: "Suivre" })), false);
});
