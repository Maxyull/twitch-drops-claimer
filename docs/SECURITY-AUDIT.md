# SECURITY-AUDIT.md: Twitch Drops & Points (MV3)

Format: 3 passes. Any non-applicable box → `N/A + reason`.
A good part of these boxes is **checked automatically** by `tests/extension.test.js`:
marked with `[test]` at the end of the line. Those checks run on every `npm test`.

---

## Permission table

| Permission | Justification | Alternative considered | Status |
|---|---|---|---|
| `storage` | Settings, counters, "action required" list, campaign cache (`local`); tab state and heartbeats (`session`). | None: without storage the extension does not survive a service worker restart. | ✅ |
| `alarms` | Periodic loops: tab upkeep (1 min), campaign discovery (30 min), claim sweep (15 min). An MV3 service worker cannot hold a `setInterval`. | `setInterval` in the SW, rejected: the worker is killed after 30 s of inactivity. | ✅ |
| `notifications` | Warn about a claimed drop, and above all about an action to take outside Twitch (account to link). That was an explicit part of the feature request. | Badge only, rejected: the user never notices a blocked campaign. | ✅ |
| `webRequest` | **Listen only**, never blocking nor modifying. Two uses: reuse the headers the Twitch page already sends to its API (including `Client-Integrity`, without which Twitch answers "failed integrity check"), and observe the requests that prove viewing is being counted. | Injecting a MAIN-world script to hook `fetch` inside the page, rejected: far more intrusive, and it would break the "the content script injects nothing" rule. | ✅ |
| ~~`cookies`~~ | **Not requested since header reuse landed.** Authorisation comes from the page's own request; the extension no longer reads any cookie. | none | ✅ dropped |
| ~~`tabs`~~ | **Not requested.** `chrome.tabs.create/update/remove/get/reload` work without it. `chrome.tabs.query` is used to find orphan tabs, but **always filtered by URL**: it is then the host permission on `www.twitch.tv` that grants access to the result. A test fails if the query ever goes out without a filter, or with a pattern absent from `host_permissions`. Tab titles and favicons are never read. | none | ✅ dropped |

| Host permission | Justification |
|---|---|
| `https://www.twitch.tv/*` | Content script (player + claim clicks) and background tabs. |
| `https://gql.twitch.tv/*` | Twitch GraphQL API: campaign list, progress, live channels, joining a raid, claiming points and drops. Also where headers are picked up. |
| `https://spade.twitch.tv/*` | **Observation only.** This is where the Twitch player sends its watch-time pings. Seeing them is the only direct proof that viewing is being counted. |
| `https://*.ttvnw.net/*` | **Observation only.** Twitch's video CDN. Dynamic subdomains (`video-edge-XXXX.abs.hls.ttvnw.net`), hence the unavoidable wildcard. Seeing segments go by proves the stream is really being consumed, which covers the case of a blocker killing the pings above. |

⚠️ Those last two hosts are **never contacted**, only listened to. A regression test
checks that the only `fetch` in the code targets `GQL_URL` or a package resource. Only
the timestamp and the kind of the request are kept, never its content nor its headers.

No optional permissions: the four above are all used within the first working cycle.
`[test]` checks that no declared permission is unused, and that no API is used without
its permission.

### Reusing the page's headers

Twitch computes `Client-Integrity` in its own JavaScript; an extension cannot forge it.
So the extension observes the requests the page already sends and reuses seven headers,
listed explicitly in `src/lib/gql-headers.js`: `authorization`, `client-id`,
`client-integrity`, `client-session-id`, `client-version`, `device-id`, `x-device-id`,
`accept-language`.

What is **never** reused, protected by a regression test: the `Cookie` header. It
carries the full session, our request does not need it, and storing it would be a free
leak.

Accepted functional consequence: without an open Twitch tab, the extension cannot query
the API. It opens one itself when that happens.

---

## PASS 1: manifest & attack surface

### Manifest
- [x] `manifest_version: 3`, no MV2 leftovers `[test]`
- [x] `permissions`: every entry present in the table above `[test]`
- [x] `host_permissions`: four hosts, only one subdomain wildcard (`*.ttvnw.net`),
      justified above by the video CDN's dynamic subdomains. No TLD wildcard. `[test]`
- [x] No `<all_urls>` `[test]`
- [x] `optional_permissions`: empty. N/A, every permission is used at startup
- [x] `content_scripts.matches`: `https://www.twitch.tv/*` only, no TLD wildcard `[test]`
- [x] `content_scripts.run_at` justified: **`document_start` on purpose**. Quality and
      volume are written to `localStorage` **before** the Twitch player initialises; at
      `document_idle` the player has already started at source quality.
      `all_frames: false`. `[test]`
- [x] `web_accessible_resources`: exactly 4 files (the content script module and the 3
      modules it imports), `matches` restricted to Twitch, `use_dynamic_url: true`
      `[test]`. `src/lib/quality.js` joined it with the audio-only quality: a pure
      module, no data, it only picks a menu entry from labels
- [x] `externally_connectable`: absent `[test]`
- [x] CSP: no `content_security_policy` declared, so the MV3 default applies `[test]`
- [x] `default_locale: "fr"`, icons 16/32/48/128 present `[test]`

### Remote code / injection
- [x] No `eval`, `new Function`, `setTimeout(string)` `[test]`
- [x] No external `<script src=` `[test]`, no inline script `[test]`
- [x] No JS fetched then executed. The only dynamic `import()`
      (`src/content/content.js`) points at a **package** resource, resolved through
      `chrome.runtime.getURL` `[test]`
- [x] `innerHTML` / `insertAdjacentHTML` / `document.write`: **zero occurrences** in
      `src/` `[test]`
- [x] Data coming from Twitch (campaign and drop names) is set through `textContent`
      only, including in the popup and the options page

---

## PASS 2: messaging, storage, data

### Messaging
- [x] `onMessage` validates `sender.id === chrome.runtime.id` `[test]`
- [x] Content script messages treated as **untrusted**: `src/lib/message-guard.js`
      validates the type, the shape and the bounds of every field before processing
      (`tests/message-guard.test.js`)
- [x] **Origin partitioning**: messages that drive the extension (`set-settings`,
      `get-state`, `refresh-now`, `blacklist-campaign`) are **refused** when they come
      from a tab. A compromised Twitch cannot change the settings.
- [x] A tab message whose URL is not `https://www.twitch.tv` is refused
- [x] `onMessageExternal`: absent
- [x] No dynamic dispatch without an allowlist: the type table is read with
      `Object.hasOwn`, otherwise `"constructor"` or `"toString"` would get through the
      allowlist via `Object.prototype` (hole found and closed during this audit)
- [x] `window.postMessage`: no occurrences. The content script never talks to the page.
- [x] No sensitive data sent to the host page: the content script writes nothing into
      Twitch's DOM, it only reads and clicks

### Storage
- [x] `chrome.storage.local`: no secrets. **The Twitch token is never written there.**
      Contents: settings, counters, claim log, action list, campaign cache, Twitch login
      and account id, last error.
- [x] The headers reused from the page, which carry the session token and the integrity
      token, live in **`chrome.storage.session`**: memory only, cleared when Chrome
      closes, never written to disk. That is exactly the "session tokens in `session`
      where possible" recommendation. They are discarded as soon as Twitch refuses them,
      which forces a fresh capture.
- [x] `session` also holds tab ids and heartbeats.
- [x] Versioned schema: `STORAGE_VERSION = 2` + `migrate()` called on install and on
      startup. Migration written from v1 (the original extension). `[test]`
- [x] Quota: every write goes through `write()`, which catches the error, logs it and
      surfaces it in the UI through `lastError`. No silent failure.
- [x] Uninstall: no data outside the browser, `chrome.storage` is purged by Chrome. No
      `uninstall_url` (nothing to clean up server-side).

### Data & network
- [x] **Inventory of collected data: none of it leaves the machine.** Details in
      `docs/PRIVACY.md`. The project owns no server.
- [x] Every outbound fetch: HTTPS, a single domain (`gql.twitch.tv`). Reading a package
      resource through `chrome.runtime.getURL` is allowed and restricted to `_locales/`,
      which is how the translation catalogue is loaded `[test]`
- [x] **A single socket**, `wss://pubsub-edge.twitch.tv/v1`, Twitch's real-time channel.
      Encrypted, and a regression test checks no other `ws://` or `wss://` address
      appears in the code. It carries the session token in its subscription frame: the
      same token, to the same issuer, and it never leaves `chrome.storage.session`. No
      user data is sent, only a subscription to their own events. It can be switched off
      from the settings.
- [x] No telemetry, not even anonymous
- [x] `docs/PRIVACY.md` up to date
- [x] No backend, so N/A for RLS and short-lived tokens
- [x] **No `Client-Id` is hardcoded.** It is read from the headers the Twitch page
      already sends, like the rest. It would not be a secret either way, being the
      public identifier of Twitch's own web client, but there is nothing in the code to
      argue about. `[test]` checks that no string resembling a private key is hardcoded.
- [x] `OP_CURRENT_DROP.hash` (`src/background/gql.js`) is the **public fingerprint of a
      query registered with Twitch** (`DropCurrentSessionContext`), the one its own site
      sends. It is not a key: it grants no access, it designates a query. It exists so we
      can call an operation whose exact signature is not public, rather than guessing one.
      If Twitch retires it, the API answers `PersistedQueryNotFound`, the code recognises
      it (`kind: "persisted"`), stops calling and falls back to the inventory.

---

## PASS 3: supply chain, build, store

### Dependencies
- [x] **Zero runtime dependencies**, vanilla extension, no `node_modules` in the package
- [x] `npm audit --audit-level=high`: blocking in CI
- [x] `package-lock.json` committed, `npm ci` in CI. A single devDependency,
      `@playwright/test`, pinned, never shipped in the package
- [x] No dependency that would make network requests at runtime
- [x] **Actions pinned by commit SHA**, not by tag. A tag is mutable: whoever controls
      the action repository could repoint it at different code running with our token.
      Dependabot covers `github-actions` precisely because pinning freezes them.
- [x] **CodeQL** (`security-extended`) and **gitleaks** (working tree + full history) run
      on every push and pull request, plus weekly. `.gitleaks.toml` adds a rule for the
      Twitch OAuth session token, which the default rules do not cover.

### Build & release
- [x] `python scripts/build.py` builds `dist/` with **only** what ships (manifest,
      `src/`, `_locales/`, `assets/`) then `release/twitch-drops-claimer-vX.Y.Z.zip`
- [x] The zip excludes `tests/`, `docs/`, `dev/`, `scripts/`, `.github/`,
      `package.json`, `CLAUDE.md`
- [x] Minification: **off by default** (`--minify` to enable). A readable package can be
      re-read by hand before publishing, which is the real anti-supply-chain control here.
- [ ] Chrome Web Store account on 2FA: to do at publication time
- [ ] Diff review before every publication: a procedure to hold, not automatable here

### Runtime behaviour
- [x] Service worker: no critical state in memory, everything goes through
      `chrome.storage`. No call at module load (otherwise every wake-up would restart the
      machinery).
- [x] Content script: **injects neither DOM nor CSS** into the page → no prefix needed,
      no possible collision
- [x] No `MutationObserver`: a periodic sweep every 8 s, bounded, that only reads
      attributes. No measurable degradation of the page.
- [x] Incognito: the extension is disabled by default by Chrome; if the user allows it,
      `storage.local` is the normal profile's, behaviour unchanged
- [x] Errors caught: messages surfaced in the UI are truncated to 300 characters and
      contain neither token nor cookie

### Store review readiness
- [x] Description = what the extension actually does
- [x] Justification written for every permission (table above, reusable as-is in the
      store form)
- [ ] **Single purpose policy: a point of caution.** The extension does two close things
      (channel points + drops) around one goal, "automate collecting Twitch rewards".
      Defensible, but it is the most likely rejection reason.
- [ ] Screenshots + privacy policy URL: to prepare before submission
- [ ] **Product risk, not security**: automating interactions is a grey area with regard
      to the Twitch terms. To be stated explicitly in the store listing.

---

## Quick greps

```bash
grep -rn "eval\|new Function" src/
grep -rn "innerHTML\|insertAdjacentHTML\|document.write" src/
grep -rn "postMessage" src/
grep -rn "http://" src/ manifest.json
grep -rn "unsafe-" manifest.json
grep -rn "all_urls" manifest.json
```

Those six greps are doubled by `tests/extension.test.js`, which fails if any of them
returns something.

## Audit history

| Date | Pass | Auditor | Outcome |
|---|---|---|---|
| 2026-08-03 | 1, 2, 3 | Claude | 2 fixes: `tabs` permission dropped (unnecessary), message allowlist bypass through `Object.prototype` closed. Left open: `package-lock.json`, store preparation. |
| 2026-08-04 | 1, 2, 3 | Claude | Repository hardening: actions pinned by SHA, CodeQL, gitleaks, Dependabot. Corrected a stale claim in this file: no `Client-Id` is hardcoded, it is captured from the page. |
