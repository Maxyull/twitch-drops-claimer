// The French button labels below are data, not prose: they are what the Twitch
// interface reads in French, and they are exactly what these rules must match.
// Translating them would make the tests stop testing anything real.

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

/** The balance button, always next to the chat, chest or no chest. */
const SOLDE_DE_POINTS = btn({
  text: "1 234",
  aTarget: "community-points-summary",
  ariaLabel: "Points de chaîne",
  context: "/zerator community-points-summary tw-flex",
});

/** The chest: its class is carried by an icon INSIDE the button. */
const COFFRE = btn({
  ariaLabel: "Réclamer un bonus",
  inner: "claimable-bonus__icon tw-svg",
  context: "/zerator community-points-summary",
});

const INVENTORY_CTX = "/drops/inventory drops-campaign-in-progress tw-tower";

test("clicks the official drop claim button", () => {
  assert.equal(
    isDropClaimButton(btn({ testSelector: DROP_CLAIM_SELECTORS[0], text: "Réclamer", context: INVENTORY_CTX })),
    true,
  );
});

test("falls back on the label, but only in a Drops context", () => {
  assert.equal(isDropClaimButton(btn({ text: "Réclamer", context: INVENTORY_CTX })), true);
  assert.equal(isDropClaimButton(btn({ text: "Claim", context: INVENTORY_CTX })), true);
  assert.equal(isDropClaimButton(btn({ text: "Récupérer", context: INVENTORY_CTX })), true);
  // Same label, but nothing proves we are in the drops area: hands off.
  assert.equal(isDropClaimButton(btn({ text: "Réclamer", context: "/zerator sidebar" })), false);
});

test("REGRESSION: never clicks a commercial offer", () => {
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
    assert.equal(isDropClaimButton(b), false, `wrongly clicked: ${b.text} / ${b.context}`);
  }
});

test("REGRESSION: even with the official selector, a Prime offer is refused", () => {
  assert.equal(
    isDropClaimButton(
      btn({ testSelector: DROP_CLAIM_SELECTORS[0], text: "Réclamer", context: "prime-offer" }),
    ),
    false,
  );
});

test("an invisible or disabled button is never clicked", () => {
  const base = { testSelector: DROP_CLAIM_SELECTORS[0], text: "Réclamer", context: INVENTORY_CTX };
  assert.equal(isDropClaimButton(btn({ ...base, visible: false })), false);
  assert.equal(isDropClaimButton(btn({ ...base, disabled: true })), false);
  assert.equal(isDropClaimButton(null), false);
});

test("a near-miss label is not enough", () => {
  assert.equal(isDropClaimButton(btn({ text: "Réclamer plus tard", context: INVENTORY_CTX })), false);
  assert.equal(isDropClaimButton(btn({ text: "", context: INVENTORY_CTX })), false);
});

test("channel points chest", () => {
  assert.equal(isPointsBonusButton(COFFRE), true, "marker carried by a child of the button");
  assert.equal(isPointsBonusButton(btn({ context: "claimable-bonus__icon" })), true);
  assert.equal(isPointsBonusButton(btn({ testSelector: "claimable-bonus" })), true);
  assert.equal(isPointsBonusButton(btn({ ariaLabel: "Claim your bonus" })), true);
  assert.equal(isPointsBonusButton({ ...COFFRE, visible: false }), false);
  assert.equal(isPointsBonusButton({ ...COFFRE, disabled: true }), false);
});

test("REGRESSION: the points balance button is not the chest", () => {
  // It is ALWAYS there, chest or no chest. Matching on it meant clicking the
  // balance, opening the points menu, never reaching the chest, and reporting a
  // claim that had not happened.
  assert.equal(isPointsBonusButton(SOLDE_DE_POINTS), false);
});

test("REGRESSION: the points container is not enough on its own", () => {
  const voisins = [
    btn({ context: "community-points-summary", text: "Voir les récompenses" }),
    btn({ aTarget: "community-points-summary", ariaLabel: "Ouvrir le menu" }),
    btn({ context: "community-points-summary", ariaLabel: "Bonus" }), // "bonus" with no verb
  ];
  for (const b of voisins) {
    assert.equal(isPointsBonusButton(b), false, `wrongly clicked: ${b.ariaLabel || b.text}`);
  }
});

test("overlays to dismiss so the player restarts", () => {
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
