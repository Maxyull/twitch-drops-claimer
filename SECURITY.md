# Security policy

## Reporting a vulnerability

**Use GitHub's private reporting**: the repository's *Security* tab →
*Report a vulnerability*. The discussion stays private until there is a fix.

Do not open a public issue for a vulnerability: this repository is public, and
so is the issue.

Expect a first answer within a few days. This project is maintained by one
person, in their own time; there is no on-call rotation and no bounty.

## What this extension actually holds

There is **no server, no account, no telemetry**. Nothing leaves the machine
except calls to Twitch itself (details in [`docs/PRIVACY.md`](docs/PRIVACY.md)).
The attack surface is three things:

1. **The Twitch session token**, reused from the headers the page already sends.
   It lives in `chrome.storage.session`: memory only, never written to disk. It
   goes to `gql.twitch.tv` and `wss://pubsub-edge.twitch.tv`, nowhere else.
2. **The background tabs**, opened on `www.twitch.tv` only.
3. **What is stored**: settings, counters, claim log, campaign cache. No secrets.

The full reasoning, pass by pass, is in
[`docs/SECURITY-AUDIT.md`](docs/SECURITY-AUDIT.md).

## What we genuinely want to hear about

In order of severity, what justifies a private report:

- **The session token leaking outside Twitch**: written to disk, sent to another
  host, exposed to a web page.
- **A page managing to make the extension act.** Every message goes through
  `src/lib/message-guard.js`: sender identity, type allowlist, origin, and
  bounds on every field. A bypass is a vulnerability.
- **Code execution from elsewhere.** There is no `eval`, no `new Function`, no
  CDN; the only dynamic `import()` targets a package resource. Any path that
  would execute something else is a vulnerability.
- **Injection through Twitch data.** Campaign and drop names are not trusted:
  they are set through `textContent`. Anywhere that would let them be
  interpreted as HTML is a vulnerability.
- **A permission or a host broader than necessary**, or a call that would
  require an undeclared permission.

Each of these is frozen by a regression test in `tests/extension.test.js`. If
you break one of them, say so: the test is probably too weak.

## What is not a vulnerability

To save both sides a round trip:

- **The `Client-Id` used by the API calls** is the public identifier of Twitch's
  own web client, visible in any request the site makes. It is not hardcoded
  here anyway: it is read from the headers the page already sends.
- **`OP_CURRENT_DROP.hash`** designates a query registered with Twitch. It
  grants no access and opens nothing.
- **The fact that the extension automates Twitch** is a terms-of-service
  question, not a security one. It is stated plainly in the
  [README](README.md), and the user decides for themselves.
- **A vulnerable dev dependency** that never ships. The zip carries no
  `node_modules`, no `tests/`, no `scripts/`.
- **An automated scanner report with no exploitation path.** Say what an
  attacker concretely gets, otherwise there is nothing to fix.

## Supported versions

Only the latest released version gets fixes. The project has no maintenance
branch.

## After a fix

The fix ships as a public PR with, like every fix here, the test that fails
without it. The report is credited in the PR unless you ask otherwise.
