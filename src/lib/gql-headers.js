// Twitch protège son API GraphQL par un jeton d'intégrité (`Client-Integrity`)
// calculé par son propre JavaScript, dans la page. Impossible de le fabriquer
// depuis une extension : sans lui, toute requête reçoit « failed integrity check ».
//
// La solution retenue : observer les en-têtes que la page Twitch envoie déjà pour
// ses propres requêtes, et les réutiliser tels quels. On ne fabrique rien, on ne
// contourne aucune protection, on emprunte la session que l'utilisateur a ouverte.
//
// Module pur : le tri et la péremption sont testables sans navigateur.

/** En-têtes repris de la page. Tout le reste est ignoré. */
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

/** Le jeton d'intégrité est renouvelé régulièrement par la page. */
export const HEADERS_MAX_AGE_MS = 30 * 60_000;

/**
 * @param {Array<{name:string, value:string}>} requestHeaders  tels que fournis par webRequest
 * @returns {Object<string,string>} en-têtes conservés, noms d'origine préservés
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

/** Une capture n'est exploitable que si elle porte le jeton d'intégrité et l'autorisation. */
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
 * En-têtes à envoyer, capture fusionnée avec nos propres valeurs.
 * `Content-Type` est à nous : c'est notre corps de requête, pas celui de la page.
 */
export function buildRequestHeaders(captured) {
  return { ...(captured?.headers ?? {}), "Content-Type": "application/json" };
}
