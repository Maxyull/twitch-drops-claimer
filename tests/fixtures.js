// Samples of GQL responses, cut down to the fields the extension reads.

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function campaignNode(overrides = {}) {
  const now = Date.now();
  return {
    id: "camp-1",
    name: "Campagne de test",
    status: "ACTIVE",
    startAt: new Date(now - DAY).toISOString(),
    endAt: new Date(now + 3 * DAY).toISOString(),
    detailsURL: "https://example.com/details",
    accountLinkURL: "",
    self: { isAccountConnected: true },
    game: { id: "g1", slug: "jeu-test", displayName: "Jeu Test" },
    allow: { isEnabled: true, channels: [] },
    timeBasedDrops: [
      {
        id: "drop-1",
        name: "Coffre en bois",
        requiredMinutesWatched: 60,
        benefitEdges: [{ benefit: { id: "b1", name: "Coffre", imageAssetURL: "https://img" } }],
        self: { isClaimed: false, currentMinutesWatched: 30, dropInstanceID: null },
      },
      {
        id: "drop-2",
        name: "Coffre en fer",
        requiredMinutesWatched: 120,
        benefitEdges: [{ benefit: { id: "b2", name: "Coffre 2", imageAssetURL: "https://img2" } }],
        self: { isClaimed: false, currentMinutesWatched: 0, dropInstanceID: null },
      },
    ],
    ...overrides,
  };
}

/** A campaign restricted to a list of channels. */
export function restrictedCampaignNode(logins, overrides = {}) {
  return campaignNode({
    id: "camp-restreinte",
    allow: {
      isEnabled: true,
      channels: logins.map((login, i) => ({ id: `c${i}`, name: login, displayName: login })),
    },
    ...overrides,
  });
}

/** A campaign that requires linking the account at the publisher. */
export function unlinkedCampaignNode(overrides = {}) {
  return campaignNode({
    id: "camp-non-liee",
    name: "Publisher campaign",
    accountLinkURL: "https://editeur.example/link",
    self: { isAccountConnected: false },
    ...overrides,
  });
}
