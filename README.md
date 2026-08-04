# Twitch Drops & Points Auto-Claimer

[![CI](https://github.com/Maxyull/twitch-drops-claimer/actions/workflows/ci.yml/badge.svg)](https://github.com/Maxyull/twitch-drops-claimer/actions/workflows/ci.yml)
[![CodeQL](https://github.com/Maxyull/twitch-drops-claimer/actions/workflows/codeql.yml/badge.svg)](https://github.com/Maxyull/twitch-drops-claimer/actions/workflows/codeql.yml)
[![gitleaks](https://github.com/Maxyull/twitch-drops-claimer/actions/workflows/gitleaks.yml/badge.svg)](https://github.com/Maxyull/twitch-drops-claimer/actions/workflows/gitleaks.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?logo=googlechrome&logoColor=white)](manifest.json)
[![Zero dependencies](https://img.shields.io/badge/runtime%20deps-0-4c9a2a)](package.json)

A Chrome extension (Manifest V3) that does four things:

1. **Watches a favourite channel in the background** and claims its points bonuses.
   Pinned tab, 160p quality, sound at 1 %, with a **green / red indicator** that says
   whether the viewing actually counts.
2. **Claims Twitch Drops** as soon as a button appears, live and in the inventory, and
   sweeps every 15 minutes for whatever is left behind.
3. **Finds running campaigns on its own**, picks a live channel handing out drops, and
   works through campaigns until they are all finished.
4. **Tells you when something has to be done outside Twitch** (linking your account with
   the publisher, redeeming a reward on their site) and shows a **checklist** so you can
   say "done".

## Install

```bash
python scripts/build.py
```

Then in Chrome: `chrome://extensions` → **Developer mode** → **Load unpacked** → pick the
`dist/` folder.

The repository root loads directly too, but `dist/` is what actually ships.

## Minimum setup

1. Be logged in to `twitch.tv` in the same browser.
2. Open the extension's **Settings** and add at least one favourite channel.
3. That is all. The popup shows the state.

To check feature by feature, read the consoles and diagnose a red indicator:
[docs/TESTING-IN-CHROME.md](docs/TESTING-IN-CHROME.md).

## The watched channels, and whether they count

The popup lists every tab the extension runs in the background: the channel, what it is
farming, for how long, and above all **whether Twitch counts it**. Clicking a row brings
that tab up.

Counting is not deduced, it is observed. The extension listens to two network signals,
without ever blocking or altering them:

| Badge | What was observed |
|---|---|
| 🟢 counted as a viewer | the Twitch player's watch ping, direct proof |
| 🟠 stream downloading | video segments are arriving, but no ping seen (ad blocker?) |
| 🔴 not counted | nothing for too long, or the player is stopped |
| ⚪ checking | the tab just opened, too early to say |

The orange state exists because an ad blocker can kill the ping without stopping the
counting: answering "no" in that case would be a lie.

## The green / red indicator

The content script sends a heartbeat every 5 seconds with the player's real state. The
indicator is **green** only if the video clock is actually moving.

| Indicator | What it means |
|---|---|
| 🟢 watching | watch time is accumulating |
| 🟢 ad playing | normal, time keeps counting |
| 🔴 playback refused by the browser | unmuted player in a background tab |
| 🔴 player paused / stream frozen | time is not counting |
| 🔴 channel offline | the channel stopped, the extension will find another |
| 🔴 no answer from the tab | tab discarded by Chrome, or script blocked |
| 🔴 tab closed | the background tab was closed by hand |

The badge on the icon takes the worse of the two indicators. It turns **orange with a
number** when actions are waiting for you outside Twitch.

### Where the displayed progress comes from

Three sources, at three rhythms:

- **To the second**, Twitch's real-time channel (PubSub): it announces an available chest
  or a drop tier landing the moment it happens. It is what the Twitch site uses for
  itself. Pure acceleration: the connection can drop at any time, everything below keeps
  running and reopens it on the next minute.
- **Every minute**, `DropCurrentSessionContext`: the tier Twitch is currently advancing on
  the watched channel, and its minutes. It is light, it is the query made for this, and it
  is what both reference miners use.
- **Every 5 minutes**, the full inventory: the state of every campaign, including the ones
  not currently in front.

A counter never goes down: the sources do not refresh at the same rhythm, and an older
value arriving after a newer one would make the bar move backwards.

If Twitch retires the first query, the extension notices, stops calling it and carries on
with the inventory alone. Freshness is lost, the measurement is not.

### And if nobody is looking at the indicator

An indicator only helps whoever opens the popup. You start farming in the evening, you do
not reopen it, and you find out in the morning that it stopped at 10 pm.

So the extension **warns on its own** when nothing has been counted for 15 minutes
(configurable), with the indicator's reason. It only repeats once an hour while it lasts:
one notification a minute would get the extension uninstalled faster than the failure
itself. And having nothing to do, for want of a favourite channel or a live campaign, is
not a failure: it does not alert.

## Why tabs are muted

This is not just a comfort: **Chrome refuses to start a video with sound in a background
tab** without a prior user gesture. An unmuted player therefore never starts, and nothing
gets counted. Muted playback, on the other hand, is always allowed.

The setting can be turned off if you insist, but expect the "playback refused by the
browser" indicator. In that case the extension briefly activates the tab to unblock the
player, at most once every three minutes.

Muting is applied twice: on the player by the content script, and on the tab itself. If
the content script fails to load, Twitch starts at the volume you saved and the tab starts
talking on its own; the tab-level mute covers that.

By default the extension keeps **a minimised window of its own** for its tabs. That is
what lets it do that wake-up without ever stealing focus from the window you work in. It
moves one tab forward on each pass, so each gets its turn in front, which is enough to
restart a player the browser had set aside.

**It always gives the place back.** An activated tab stays in front for five seconds, long
enough for the player to start, then whatever was there returns. An extension that
confiscates the tab you were watching is not worth the gain. Clicking a row in the list
brings up that tab if you want to go there yourself, and then it stays.

Quality is dropped to 160p to save bandwidth. The settings also offer **audio only**, when
the channel provides it: no image is decoded at all, which costs far less bandwidth and
CPU across several tabs at once.

Two honest caveats:

- Not every channel offers audio only. If the entry is missing from the player menu, the
  extension **changes nothing** rather than degrading at random.
- A stream without video is still viewing as far as Twitch is concerned, but the extension
  does not guarantee that on its behalf: the row's **"counted as a viewer"** badge is what
  settles it. If it turns to "not counted" after the change, go back to 160p.

## What you need to know

- **You must be logged in to Twitch, and keep a Twitch tab open.** The Twitch API requires
  an integrity token that its own JavaScript computes inside the page; an extension cannot
  forge it. So the extension reuses the headers the page already sends. Without a Twitch
  tab the popup shows "waiting for a Twitch tab" and opens one itself. Details in
  [docs/PRIVACY.md](docs/PRIVACY.md).
- **Several farming tabs, but Twitch probably counts only one.** The setting opens two
  tabs by default, on two campaigns and two different channels. Nobody guarantees Twitch
  advances both: that is exactly why every popup row carries its own counting badge. Look
  at those rather than taking my word for it.
- **Tabs close themselves when they are no longer useful.** No favourite channel live, no
  campaign left to farm, inventory already swept: the tab disappears. The one case where
  the inventory tab is kept is when it is the last Twitch tab, because it is then also
  what lets us pick up the integrity token.
- **Do not let background tabs be discarded.** The extension sets
  `autoDiscardable: false`, which is enough in most cases. If an indicator stays red on
  "no answer from the tab", turn off the memory saver for `twitch.tv` in
  `chrome://settings/performance`.
- **"Fast claim" is off by default.** Turned on, the extension claims drops directly
  through the API instead of simulating a click. It is more reliable, but it is a choice
  to make knowingly.
- **Grey area with regard to the Twitch terms.** Automating claim clicks is not explicitly
  forbidden, and not explicitly allowed either. Your call, on your account.

## Development

```bash
npm test                  # unit and regression tests, no browser
npm run preview           # preview the popup and settings at http://localhost:8791
npm run build             # dist/ + release/*.zip
npx playwright test       # e2e on dist/ loaded into Chromium
```

`npm run preview` serves `dev/popup-preview.html` and `dev/options-preview.html`: the real
views, with a stubbed `chrome` API and fake data. Handy for working on layout without
reloading the extension.

| Where | What |
|---|---|
| [CONTRIBUTING.md](CONTRIBUTING.md) | conventions, issue / PR / merge workflow |
| [docs/PITFALLS.md](docs/PITFALLS.md) | **read before touching the code**: what Chrome and Twitch impose, and why the code looks the way it does |
| [SECURITY.md](SECURITY.md) | reporting a vulnerability, and what counts as one here |
| [docs/SECURITY-AUDIT.md](docs/SECURITY-AUDIT.md) | permissions argued one by one, three audit passes |
| [docs/PRIVACY.md](docs/PRIVACY.md) | what is stored, what leaves the machine |
| [docs/TESTING-IN-CHROME.md](docs/TESTING-IN-CHROME.md) | checking each feature by hand |
| [docs/MANUAL-CHECKS.md](docs/MANUAL-CHECKS.md) | what CI cannot prove, tracked in issue [#56](../../issues/56) |

### Known limitation of the development machine

The Playwright e2e tests **do not run on this machine**: the Chromium that Playwright
downloads refuses to start ("side-by-side configuration is incorrect", a missing Visual C++
runtime). They are written and run by GitHub CI, where the problem does not occur. To run
them locally, install the *Microsoft Visual C++ Redistributable* and re-run
`npx playwright install chromium`.

## If it breaks one day

Twitch changes its DOM regularly. The likely breaking points, in order:

1. **Buttons stop being clicked** → `src/lib/dom-rules.js`, add the new
   `data-test-selector` to `DROP_CLAIM_SELECTORS`. The tests in
   `tests/dom-rules.test.js` say immediately if the rule becomes too permissive.
2. **"failed integrity check"** → the token taken from the page expired, or Twitch renamed
   its headers. See `FORWARDED_HEADERS` in `src/lib/gql-headers.js` and compare with a real
   request (F12 on a Twitch tab, Network, filter `gql`, Request Headers).
3. **Campaign discovery fails some other way** → `src/background/gql.js`, a query changed
   shape. The popup shows the exact error Twitch returned.
4. **The content script module stops loading** → `use_dynamic_url: true` in the manifest is
   the first suspect; flip it to `false` to check.
