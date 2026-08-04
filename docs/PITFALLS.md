# Pitfalls, and why the code looks the way it does

This file exists because every line in it cost a bug, often several round trips,
and none of it can be guessed by reading the code. Each entry states **the trap**,
**what we believed**, and **what is actually true**.

The linked issues keep the details, including the ruled-out hypotheses.

---

## Chrome

### Autoplay with sound is refused in a background tab

A background tab **never** starts an unmuted video: Chrome refuses `play()`
without a prior user gesture, with `NotAllowedError`.

Muting is therefore not a comfort, it is what makes the farm work. The setting can
be turned off, but the indicator then reads "playback refused by the browser".
See [#6](../../../issues/6).

Corollary: muting is applied **twice**, on the player by the content script and on
the tab itself. If the script fails to load, Twitch starts at the volume the user
saved and the tab starts talking on its own.

### `chrome.storage.session` is cleared on every extension reload

Not only when the browser closes. Anything that must survive a
`chrome://extensions` → reload belongs in `local`.

Three "extra window" reports had this single cause, fixed three times the wrong
way before it was seen. See [#42](../../../issues/42), plus
[#31](../../../issues/31), [#36](../../../issues/36), [#40](../../../issues/40)
for the patches that preceded it.

The split is explicit in `src/lib/storage.js`: `PERSISTENT_STATE_KEYS` on one
side, everything else in session.

### What does NOT require the `tabs` permission

- `chrome.tabs.create` / `update` / `remove` / `get` / `reload`
- `chrome.tabs.update(id, { muted })`
- `chrome.tabs.query` **filtered by a URL covered by `host_permissions`**
- `chrome.tabs.query({ active: true, windowId })`, where only the id is read

What would require it: reading `url`, `title` or `favIconUrl` of a tab outside the
host scope. Regression tests freeze those limits, and they have been **tightened**
every time a new call appeared, never loosened.

### A socket dies with the service worker, unless it keeps talking

Chrome recycles an idle service worker after **30 seconds**. An open WebSocket is
not enough to keep it awake: what counts is traffic. With nothing arriving, the
socket goes down with the worker.

Hence the 20-second heartbeat in `src/background/pubsub.js`: it keeps the
connection open on the Twitch side **and** the worker awake on the Chrome side.
It is the only exception to "no `setInterval`, everything through
`chrome.alarms`" in `CLAUDE.md`, because an alarm cannot go below one minute. The
heartbeat is tied to the socket's lifetime and disappears with it.

Accepted corollary: **nothing depends on that socket.** It is only an
acceleration. If the worker is recycled anyway, the one-minute loop reopens it,
and the periodic queries covered the gap.

### `windows.create({ state, focused })`

The two properties overlap. The window is created unfocused, then minimised, in
two steps.

---

## Twitch

### The GraphQL API requires an integrity token we cannot forge

Without a `Client-Integrity` header, every request gets `failed integrity check`.
That token is computed by Twitch's own JavaScript, inside the page.

So the extension reuses the headers the page already sends, listed explicitly in
`src/lib/gql-headers.js`. Accepted consequence: **it needs at least one open
Twitch tab** to query the API.

Happy side effect: authorisation comes from the same place, so the `cookies`
permission could be dropped. See [#25](../../../issues/25) and the audit.

### Twitch rewrites the URL constantly

It is a single-page application: the `#tdc` fragment that marks the extension's
tabs disappears on every internal navigation. The content script puts it back, but
**only while it is alive**. After an extension reload, nobody puts it back.

That marker is therefore a safety net, never the source of truth.

### A Twitch page contains several `<video>` elements

Sidebar previews, recommendation banner, ads. `querySelector("video")` returns
whichever comes first, often a stopped one, and the whole diagnosis starts from
there. We take the one that is playing, and failing that the biggest.
See [#16](../../../issues/16).

The original filter also required `videoWidth > 0`, which looked harmless: a
player with no image is not a player. **Except in audio-only quality**, where the
legitimate stream has precisely no image and was therefore discarded. The
criterion fell back to `!paused && readyState >= 2`, which was already enough to
discard the stopped previews, the actual original problem.

### The last entry in the quality menu is "Audio Only"

Lowering the quality by clicking the last entry in the menu looks obvious. The
real order is: Auto, Source, 720p60, ..., 160p, **Audio Only**. So the "lowest
quality" fallback was cutting the image on channels that offer audio only, without
anyone asking for it, and it made us lose the right `<video>` to the trap above.

The choice is now made on the label, in `src/lib/quality.js`: a pure module,
tested against the real menus in French and English. The word "audio" appears in
no other entry, and certainly not in "Auto".

### A raid exists nowhere but in PubSub

There is no reliable trace of a raid in the page, least of all its id, without
which it cannot be joined. It comes only from the `raid.<channel id>` topic,
message `raid_update_v2`. The neighbouring shapes (`raid_go_v2`,
`raid_cancel_v2`) do not carry it.

Two consequences nothing hints at:

- **A raid moves the tab.** Twitch redirects the viewer to the target. On a
  farming tab that target almost never carries the campaign: viewing stops
  counting, and the indicator only says so on the next pass.
- **The bonus and the drift are not handled the same way.** The bonus only makes
  sense on the favourite channel, the one that was chosen. Taking it on a farming
  tab would mean harvesting at a stranger's.

### `community-points-summary` is not the chest

It is the **balance** container, always present next to the chat. Settling for it
meant clicking the balance, opening the points menu, never reaching the chest, and
reporting a claim that had not happened.

The real marker, `claimable-bonus`, is carried by an icon **inside** the button:
you have to read the markers of the children, not only of the ancestors.
See [#12](../../../issues/12).

Since then the bonus is claimed through the API, which explicitly says a chest is
waiting and confirms it was taken. The click stays as a fallback for tabs the user
opens themselves. Watch out for double counting: deduplication happens at two
levels in `farm.js`.

### The inventory is not built for tracking progress

It returns every started campaign: heavy, therefore requested rarely, therefore
the displayed progress lags. The popup bar stayed frozen for half an hour for that
reason ([#49](../../../issues/49)).

Twitch has a query made for this, `DropCurrentSessionContext`: one tier, its
minutes, nothing else. It is what
[TwitchDropsMiner](https://github.com/DevilXD/TwitchDropsMiner) and
[Twitch-Channel-Points-Miner-v2](https://github.com/Tkd-Alex/Twitch-Channel-Points-Miner-v2)
use. Its exact signature is not public, so we call it by its **persisted query
fingerprint**, the way the site itself does, rather than inventing a query by
guesswork.

Corollary: a fingerprint can be retired. The API then answers
`PersistedQueryNotFound`, the code recognises it, stops calling and falls back to
the inventory. Freshness is lost, the measurement is not.

### A cache must never carry progress

The campaign structure cache was also serving `isClaimed`, six hours old. A drop
claimed in the meantime stayed invisible and the counter did not move. Structure
is cached, progress comes from the inventory. See [#27](../../../issues/27).

### Twitch probably advances only one stream at a time

**Probably.** Nobody guarantees it, and the extension does not settle it on their
behalf: it opens several farming tabs if asked, and the "counted as a viewer"
badge on each row says which one is actually advancing.

---

## Principles that came out of these bugs

### Evidence always beats deduction

Player state read from the DOM is a deduction, and it was wrong. Downloaded video
segments, watch pings and progress read from the inventory are facts.
`evaluateCounted` looks at the evidence **before** judging the player state, in
that precise order. See [#16](../../../issues/16).

### A counter counts what happened, not what we did

The drop counter followed our clicks. Twitch can credit a tier without us, a click
can fail silently, a message can fail to arrive. It now counts the tiers Twitch
marks as obtained, deduplicated by id.

With one precaution: the first pass counts nothing, it takes a snapshot of what
already exists. Otherwise the counter would jump from 0 to the account's entire
history. See [#14](../../../issues/14).

### Never conclude on information you do not have

`liveLogins` can fail. An empty list and a missing answer do not mean the same
thing: conflating them closes tabs on every API hiccup. The code explicitly
distinguishes `null` from `[]`.

Same logic for `isAccountConnected`: `null` means "the query did not carry that
information", not "account not linked".

### A confirmation that lies costs hours

The settings page showed "Saved" without looking at the answer. A refusal was
indistinguishable from a success, and that is what kept a bug invisible across
three PRs. See [#3](../../../issues/3) and [#35](../../../issues/35).

Worst case found: it also allowed **saving before it had loaded**, so the empty
form was written over the real settings. The buttons are now disabled until a
successful load.

### Verify before asserting

Twice here, the obvious cause was wrong: a write collision in `storage.session`
(disproved by a throwaway probe), and the `tabs` permission assumed necessary to
mute a tab. A probe costs two minutes.

Ruled-out hypotheses stay written in the issues: knowing what was **not** the
cause saves time on the next failure.

### CI is right until proven otherwise

On its own it found the options page messages being rejected, saving blocked by
tab opening, and settings being overwritten by an empty form. An intermittent CI
is worse than no CI: it teaches people to ignore red.

---

## Limitation of the development machine

The Playwright e2e tests **do not run on the development machine**: the downloaded
Chromium refuses to start, for want of the *Visual C++ Redistributable*. They are
written and executed by CI. Do not claim to have run them locally.

Local rendering checks go through `npm run preview`, which serves the real views
with a stubbed `chrome` API. Skipping that step produced an unreadable settings
page once ([#21](../../../issues/21)).
