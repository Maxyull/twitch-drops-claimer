// Twitch protects its GraphQL API with an integrity token (`Client-Integrity`)
// computed by its own JavaScript, inside the page. There is no forging it from an
// extension: without it, every request gets "failed integrity check".
//
// The approach taken: observe the headers the Twitch page already sends for its
// own requests, and reuse them as they are. Nothing is forged, no protection is
// bypassed, we borrow the session the user opened.
//
// Pure module: the filtering and the expiry are testable without a browser.

/** Headers taken from the page. Everything else is ignored. */
export const FORWARDED_HEADERS = new Set([
  "authorization",
  "client-id",
  "client-integrity",
  "client-session-id",
  "client-version",
  "device-id",
  "x-device-id",
  "accept-language",
]);

/** The page renews the integrity token regularly. */
export const HEADERS_MAX_AGE_MS = 30 * 60_000;

/**
 * @param {Array<{name:string, value:string}>} requestHeaders  as provided by webRequest
 * @returns {Object<string,string>} the headers kept, original names preserved
 */
export function pickForwardableHeaders(requestHeaders) {
  const out = {};
  for (const header of requestHeaders || []) {
    const name = header?.name;
    const value = header?.value;
    if (typeof name !== "string" || typeof value !== "string" || !value) continue;
    if (FORWARDED_HEADERS.has(name.toLowerCase())) out[name] = value;
  }
  return out;
}

function lowerKeys(headers) {
  return new Set(Object.keys(headers || {}).map((k) => k.toLowerCase()));
}

/** A capture is only usable when it carries the integrity token and the authorisation. */
export function isUsable(captured) {
  if (!captured?.headers) return false;
  const names = lowerKeys(captured.headers);
  return names.has("client-integrity") && names.has("authorization");
}

export function isStale(captured, now = Date.now()) {
  if (!captured?.at) return true;
  return now - captured.at > HEADERS_MAX_AGE_MS;
}

/**
 * The headers to send: the capture merged with our own values.
 * `Content-Type` is ours: it describes our request body, not the page's.
 */
export function buildRequestHeaders(captured) {
  return { ...(captured?.headers ?? {}), "Content-Type": "application/json" };
}
