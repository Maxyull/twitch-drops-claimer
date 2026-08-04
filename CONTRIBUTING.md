# Contributing

Chrome MV3 extension, vanilla JS, zero runtime dependencies.
Target: Chrome, Edge, Brave. Firefox is not a priority.

## Layout

```
/
├── manifest.json              # MV3 only
├── _locales/{fr,en}/messages.json
├── assets/icons/              # 16, 32, 48, 128 px
├── src/
│   ├── background/
│   │   ├── service-worker.js  # alarms, messages, badge. No long-lived in-memory state
│   │   ├── gql.js             # Twitch GraphQL client
│   │   ├── pubsub.js          # Twitch real-time channel
│   │   ├── farm.js            # orchestrator: campaigns, channels, tabs
│   │   └── notify.js
│   ├── content/
│   │   ├── content.js         # manifest-declared shim, isolated world
│   │   └── watcher.js         # dynamically imported module (player, clicks, heartbeats)
│   ├── lib/                   # PURE modules, testable under Node, no chrome API
│   ├── popup/
│   └── options/
├── scripts/{build,bump-version}.py
├── tests/                     # unit + regression (node --test), e2e/ in Playwright
├── docs/{PITFALLS,SECURITY-AUDIT,PRIVACY,TESTING-IN-CHROME,MANUAL-CHECKS}.md
├── dev/                       # local preview of the views, not shipped
└── .github/workflows/         # ci, codeql, gitleaks
```

## First: read docs/PITFALLS.md

It collects what Chrome and Twitch impose and what cannot be guessed from the code:
every entry cost a bug. Touching this project without reading it means making the
same ones again.

## Non-negotiable rules

1. **Manifest V3 only.** Never MV2, never `background.page`.
2. **Zero remote code.** No `eval`, no `new Function`, no CDN. The only dynamic
   `import()` points at a package resource through `chrome.runtime.getURL`.
3. **Minimal permissions.** Every permission is argued in `docs/SECURITY-AUDIT.md`.
   `tests/extension.test.js` fails if a permission is declared without being used,
   or if an API is used without its permission.
4. **Never `innerHTML` with untrusted data.** Campaign names come from Twitch:
   `textContent` and `createElement`, full stop.
5. **Validate every message.** Everything goes through `src/lib/message-guard.js`:
   `sender.id`, a type allowlist (with `Object.hasOwn`, otherwise `constructor`
   gets through), allowed origin, and bounds on every field.
6. **`externally_connectable` closed.**
7. **No secrets in the code.** The session token is never written to storage. The
   `Client-Id` is not hardcoded either: it is read from the headers the Twitch page
   already sends.
8. **Minimal `web_accessible_resources`.** A test checks the list is exactly what
   `watcher.js` imports, no more and no less.

## Conventions

- **English everywhere**: code, comments, docs, commit messages, issues and PRs.
  The user interface is bilingual through `_locales`, which is a separate matter.
- ES modules, `type: "module"` in the service worker.
- `camelCase` for functions and variables, `SCREAMING_SNAKE` for constants,
  `kebab-case` for files.
- Messaging: constants in `src/lib/messaging.js`. Never an inline type string;
  a test checks it.
- Storage: everything goes through `src/lib/storage.js` (defaults,
  `STORAGE_VERSION`, `migrate()`, quota caught).
- Service worker: it can be killed at any moment. No long `setInterval`,
  everything through `chrome.alarms`, all state in `chrome.storage.session` or
  `local`. One documented exception: the 20-second heartbeat in
  `src/background/pubsub.js`, tied to the socket's own lifetime.
- Content script: it injects **no** DOM and no CSS into the page. Should that ever
  be needed, prefix with `tdc-`.
- **`src/lib/` stays pure**: no `chrome` API, no `fetch`. That is what makes the
  logic testable under Node, with no browser and no stubs.
- i18n: the catalogue is loaded by `src/lib/i18n.js`, not by `chrome.i18n`
  (see `src/lib/messages.js` for why). No UI string is hardcoded; a test checks
  that no key is missing and none is dead.

## Tests

```bash
npm test                  # unit and regression, no browser
npx playwright test       # e2e on dist/ actually loaded into Chromium
```

At least one test per requested permission: coverage is checked automatically in
`tests/extension.test.js`. Every new security rule comes with a test that fails if
the rule is removed.

### What CI cannot prove

The Twitch API requires an integrity token taken from an open page: no automated
test can obtain it. Frame formats, a persisted query fingerprint, the player's real
behaviour, notifications: all of that is verified by hand.

**A PR that adds such behaviour adds its section to pinned issue
[#56](../../issues/56) before merging.** The expected shape is described in
`docs/MANUAL-CHECKS.md`. A green CI on pure modules says nothing about a wire
format: that is exactly where this project can break silently.

## Build and versioning

```bash
python scripts/build.py                       # dist/ then release/*.zip
python scripts/build.py --minify              # with Terser
python scripts/bump-version.py patch --tag    # manifest.json + package.json + git tag
```

The zip excludes `tests/`, `docs/`, `dev/`, `scripts/`, `.github/` and `package.json`.

## Workflow

One change per branch, one branch per pull request. Never a direct commit on `main`.

| Situation | What you open |
|---|---|
| A feature | a `feat/...` PR |
| A bug, a security flaw | an **issue** first, then a `fix/...` PR referencing it |

### The issue, for a bug or a flaw

It describes the symptom as observed, the **verified** cause rather than the assumed
one, the impact, and what is planned.

Verify before asserting. A throwaway probe that proves the cause beats a convincing
argument: twice on this repository, the obvious cause was not the right one. A ruled
out hypothesis belongs in the issue too, since knowing what was **not** the cause
saves time on the next failure.

### The pull request

It references the issue with `Closes #N`, which closes it on merge. It explains what
was happening, why, and what changes. The title states the outcome, not the file
touched.

One PR, one thing. Two unrelated fixes make two PRs, however small. If a feature and
a fix end up on the same branch, split them before pushing.

### The merge

As soon as CI is green: squash, and delete the branch. No waiting for review, the
trace stays in the PR.

If CI is red, it is right until proven otherwise. It has already found real defects
in the extension on this repository, not just badly written tests.

## Before opening a pull request

- `npm test` green.
- A fix comes with the test that fails without it. Otherwise nothing stops the
  regression from coming back.
- Any change to `manifest.json` comes with the updated permission table in
  `docs/SECURITY-AUDIT.md`, **in the same commit**.
- Any new surface (domain, permission, message type, exposed resource) gets an entry
  in `docs/SECURITY-AUDIT.md`, same commit.
