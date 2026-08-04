// Read-only capture of the headers the Twitch page sends to its own API.
// `chrome.webRequest` is used purely as a listener: no request is cancelled and
// none is modified (see docs/SECURITY-AUDIT.md).

import { pickForwardableHeaders, isUsable, isStale } from "../lib/gql-headers.js";
import * as store from "../lib/storage.js";

export const GQL_URL_PATTERN = "https://gql.twitch.tv/*";

// Writing on every GQL request the page makes would be absurd: it makes dozens a
// minute. We only persist once the previous capture starts to age.
const REFRESH_EVERY_MS = 5 * 60_000;

let lastWriteAt = 0;

export function registerHeaderCapture() {
  chrome.webRequest.onSendHeaders.addListener(
    (details) => {
      if (details.method !== "POST") return;

      const headers = pickForwardableHeaders(details.requestHeaders);
      const candidate = { headers, at: Date.now() };
      if (!isUsable(candidate)) return;

      if (Date.now() - lastWriteAt < REFRESH_EVERY_MS) return;
      lastWriteAt = Date.now();
      void store.setCapturedHeaders(candidate);
    },
    { urls: [GQL_URL_PATTERN] },
    ["requestHeaders"],
  );
}

/**
 * @returns {Promise<{headers:object, at:number}|null>} a usable capture, or null
 */
export async function getUsableHeaders() {
  const captured = await store.getCapturedHeaders();
  if (!isUsable(captured) || isStale(captured)) return null;
  return captured;
}
