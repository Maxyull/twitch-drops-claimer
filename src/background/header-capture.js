// Capture, en lecture seule, des en-têtes que la page Twitch envoie à son API.
// `chrome.webRequest` est utilisé en simple écoute : on n'annule ni ne modifie
// aucune requête (cf. docs/SECURITY-AUDIT.md).

import { pickForwardableHeaders, isUsable, isStale } from "../lib/gql-headers.js";
import * as store from "../lib/storage.js";

export const GQL_URL_PATTERN = "https://gql.twitch.tv/*";

// Écrire à chaque requête GQL de la page serait absurde : elle en fait des dizaines
// par minute. On ne persiste que si la capture précédente commence à dater.
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
 * @returns {Promise<{headers:object, at:number}|null>} capture exploitable, ou null
 */
export async function getUsableHeaders() {
  const captured = await store.getCapturedHeaders();
  if (!isUsable(captured) || isStale(captured)) return null;
  return captured;
}
