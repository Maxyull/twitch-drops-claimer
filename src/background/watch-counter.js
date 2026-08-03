// Observation, en lecture seule, des requêtes qui prouvent que Twitch comptabilise
// le visionnage d'un onglet. On ne bloque ni ne modifie rien : `chrome.webRequest`
// est utilisé en simple écoute (cf. docs/AUDIT-SECU.md).
//
// Les segments vidéo arrivent toutes les deux secondes : écrire à chaque fois dans
// le stockage saturerait le quota. On garde un cache en mémoire et on ne persiste
// qu'à intervalle, ou immédiatement pour le signal rare qu'est le ping de comptage.

import { classifyRequest } from "../lib/counted.js";
import * as store from "../lib/storage.js";

export const OBSERVED_URLS = ["https://spade.twitch.tv/*", "https://*.ttvnw.net/*"];

const FLUSH_EVERY_MS = 15_000;

// tabId -> { spadeAt, segmentAt }
const cache = new Map();
let lastFlush = 0;
let dirty = false;

function touch(tabId, kind, at) {
  const entry = cache.get(tabId) ?? { spadeAt: null, segmentAt: null };
  if (kind === "spade") entry.spadeAt = at;
  else entry.segmentAt = at;
  cache.set(tabId, entry);
  dirty = true;
  return entry;
}

async function flush() {
  if (!dirty) return;
  dirty = false;
  lastFlush = Date.now();

  const state = await store.getState();
  const counted = { ...state.counted };
  for (const [tabId, entry] of cache) counted[tabId] = { ...counted[tabId], ...entry };
  await store.setState({ counted });
}

export function registerWatchCounter() {
  chrome.webRequest.onCompleted.addListener(
    (details) => {
      if (details.tabId < 0) return; // requête hors onglet, rien à attribuer
      const kind = classifyRequest(details.url);
      if (!kind) return;

      touch(details.tabId, kind, Date.now());

      // Le ping de comptage est rare et décisif : on l'écrit tout de suite.
      if (kind === "spade" || Date.now() - lastFlush > FLUSH_EVERY_MS) void flush();
    },
    { urls: OBSERVED_URLS },
  );
}

/** Oublie un onglet fermé. */
export function forgetCountedTab(tabId) {
  cache.delete(tabId);
}

/** Force l'écriture, avant de calculer un état affiché. */
export function flushWatchCounter() {
  return flush();
}
