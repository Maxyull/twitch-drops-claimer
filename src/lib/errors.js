// Errors are described, never written out.
//
// Anything that can reach the popup used to be a French sentence built where the
// failure happened. That sentence went straight into `textContent`, so a user on
// the English interface read French, and the "no UI string is hardcoded" rule in
// CLAUDE.md was stated, believed and unenforced (issue #76).
//
// A producer now returns `{ key, params }` and the view translates it. The two
// sides can therefore be tested separately, and a new error path cannot silently
// bring a new hardcoded sentence with it: `tests/extension.test.js` fails on a
// literal handed to `setLastError`, `showError` or `renderError`.
//
// Pure module: no `chrome` API, the translator is passed in.

export const ERROR = {
  /** No Twitch tab open, so no integrity token to borrow. */
  INTEGRITY: "error_integrity",
  /** The borrowed token expired; the next Twitch page load renews it. */
  INTEGRITY_STALE: "error_integrity_stale",
  /** Twitch refused the session: 401 or 403. */
  AUTH: "error_auth",
  /** `fetch` itself failed: offline, DNS, blocked. */
  NETWORK: "error_network",
  /** Twitch retired the persisted query fingerprint. */
  PERSISTED: "error_persisted",
  /** Any other non-2xx status. */
  HTTP: "error_http",
  /** Twitch answered with its own error text, which we quote as-is. */
  TWITCH: "error_twitch",
  /** The account's login could not be read. */
  ACCOUNT: "error_account",
  /** `chrome.storage` refused a write, quota being the usual reason. */
  STORAGE: "error_storage",
  /** The dedicated window could not be found again. */
  WINDOW: "error_window",
  /** The service worker did not answer at all. */
  NO_ANSWER: "error_no_answer",
  /** The popup asked for the state and got nothing usable. */
  STATE_UNAVAILABLE: "error_state_unavailable",
  /** The options page could not read the settings. */
  SETTINGS_UNREADABLE: "error_settings_unreadable",
  /** A setting was refused, with no more precise reason available. */
  REFUSED: "error_refused",
  /** Anything not thrown by us: the raw message is the only useful thing left. */
  UNKNOWN: "error_unknown",

  // Message guard. These only fire on a bug or on something trying to drive the
  // extension, so the user gets a short sentence and the console gets the detail.
  SENDER: "error_sender",
  MESSAGE_TYPE: "error_message_type",
  NOT_PRIVILEGED: "error_not_privileged",
  NOT_TWITCH: "error_not_twitch",
  PAYLOAD: "error_payload",
};

/**
 * `GqlError.kind` -> catalogue key.
 *
 * `kind` already existed, and callers already branch on it (`integrity` reopens a
 * tab, `persisted` falls back to the inventory). Reusing it means the user-facing
 * text and the control flow cannot drift apart.
 */
const KIND_TO_KEY = {
  integrity: ERROR.INTEGRITY,
  integrity_stale: ERROR.INTEGRITY_STALE,
  auth: ERROR.AUTH,
  network: ERROR.NETWORK,
  persisted: ERROR.PERSISTED,
  http: ERROR.HTTP,
  twitch: ERROR.TWITCH,
  account: ERROR.ACCOUNT,
};

/** A `{ key, params }` pair, the only shape a producer should build. */
export function describe(key, params = []) {
  return { key, params: Array.isArray(params) ? params.map(String) : [String(params)] };
}

/**
 * Turns anything thrown into a descriptor.
 *
 * An error we did not raise carries no key, and its message is a developer string
 * rather than a sentence for a user. It is quoted inside `error_unknown` rather
 * than shown bare: a translated frame around it at least says what kind of thing
 * the reader is looking at.
 */
export function describeThrown(err) {
  const key = KIND_TO_KEY[err?.kind];
  if (key) return describe(key, err.params ?? []);
  return describe(ERROR.UNKNOWN, [err?.message ?? String(err)]);
}

/** Is this a descriptor, as opposed to the legacy `{ message }` shape? */
export function isDescriptor(value) {
  return Boolean(value) && typeof value === "object" && typeof value.key === "string";
}

/**
 * Descriptor -> text to display.
 *
 * `entry` may also be an old `{ message }` object: `lastError` survives an update
 * in `storage.local`, so a version written before this change can still be read
 * once. Showing that French sentence one last time beats showing a raw key, and
 * it disappears on the next write.
 */
export function formatError(entry, translate) {
  if (!entry) return "";
  if (isDescriptor(entry)) return translate(entry.key, entry.params ?? []);
  return typeof entry.message === "string" ? entry.message : "";
}
