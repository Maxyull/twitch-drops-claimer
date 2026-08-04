// Read-only observation of the requests that prove Twitch is counting a tab's
// viewing. Nothing is blocked and nothing is modified: `chrome.webRequest` is used
// purely as a listener (see docs/SECURITY-AUDIT.md).
//
// Video segments arrive every two seconds: writing to storage each time would
// saturate the quota. We keep an in-memory cache and persist only on an interval,
// or immediately for the rare, decisive watch ping.

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
      if (details.tabId < 0) return; // request outside any tab, nothing to attribute
      const kind = classifyRequest(details.url);
      if (!kind) return;

      touch(details.tabId, kind, Date.now());

      // The watch ping is rare and decisive: write it straight away.
      if (kind === "spade" || Date.now() - lastFlush > FLUSH_EVERY_MS) void flush();
    },
    { urls: OBSERVED_URLS },
  );
}

/** Forget a closed tab. */
export function forgetCountedTab(tabId) {
  cache.delete(tabId);
}

/** Force the write, before computing a state that will be displayed. */
export function flushWatchCounter() {
  return flush();
}
