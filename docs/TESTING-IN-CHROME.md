# Testing the extension in Chrome

A logged-in Twitch account in the same browser is mandatory: the extension reuses your
session to query the API. Without it, only clicks on already-open tabs work, and the
popup will show "No Twitch session".

---

## 1. Load the extension

```bash
python scripts/build.py
```

1. `chrome://extensions`
2. Turn on **Developer mode** (top-right switch)
3. **Load unpacked** → pick the project's `dist/` folder

You can also load the repository root directly, which works, but `dist/` is what will be
published: you may as well test exactly that.

**What must show up immediately:**

- the extension card, with no red "Errors" banner
- **"Service worker"** in clickable blue on the card
- the toolbar icon, with a badge (grey if disabled, otherwise green or red)

If a red banner appears, click it: the message points at the exact line.

---

## 2. The three consoles

This is what trips most people up: an extension has **three separate contexts**, so three
different consoles. An error in one never appears in the others.

| What you want to see | Where to look |
|---|---|
| Campaign discovery, alarms, Twitch API errors | `chrome://extensions` → the extension card → **Service worker** |
| Popup rendering, toggle clicks | right-click the icon → **Inspect popup** |
| Claim clicks, player state | Twitch tab → F12 → filter on `[TDC]` |

Content script messages use `console.debug`, so you have to tick **Verbose** in the
console's level filter, otherwise you will see nothing.

---

## 3. Minimum setup

Click the icon → **Settings** (or `chrome://extensions` → Details → Options).

Add at least one favourite channel, one per line. A handle or a full URL, both are
accepted. **Save**.

Immediate check: the field rewrites itself into lowercase handles
(`https://www.twitch.tv/ZeratoR` becomes `zerator`). If that happens, the round trip with
the service worker works.

---

## 4. Check each feature

### Channel points and the green/red indicator

Within a minute, a **pinned tab** must appear on your favourite channel.

Open the popup:

- **green** indicator + "watching" → watch time is counting
- **red** indicator → hover the badge, it says why (table in the [README](../README.md))

Check the tab itself: the player is running, sound is at 1 %, quality is 160p (player
gear icon). If quality stayed at source, the extension will retry twice through the menu
before giving up.

The purple channel-points chest is clicked automatically within 8 seconds of appearing.
The popup's "points bonus" counter goes up by 1 and a notification shows.

> The chest only appears about once every 15 minutes. Rather than waiting, look at the
> counter after half an hour of running.

### Campaign discovery

The popup's **Search** button forces the cycle instead of waiting 30 minutes.

After a few seconds the **Campaigns** tab must fill up: name, game, percentage, tiers,
time left. The one outlined in purple is the one being farmed. A **second pinned tab**
opens on a channel handing out those drops.

If the list stays empty, look at the red banner at the top of the popup: it shows the
exact error Twitch returned. The two common cases:

- "No Twitch session" → you are not logged in to twitch.tv in this browser
- "Twitch session refused" → log back in, the cookie expired

**Switch channel** forces a move to the next campaign in the list, useful to check
rotation without waiting for a campaign to finish.

### Claiming drops

Two paths, testable separately.

**Live**: when a drop completes while you are watching, Twitch shows a notification with
a Claim button. The extension clicks it within 8 seconds.

**Through the inventory**: the easiest path to trigger. Go to
`twitch.tv/drops/inventory`: if anything is claimable, the buttons are clicked on their
own. Otherwise wait for the automatic sweep (15 min by default, configurable), which
opens an inventory tab in the background and reloads it.

On every claim: "drops claimed" counter +1, a system notification, and the reward name
under the counters.

### Actions required and checkboxes

This section only fills up if one of your campaigns requires linking your account with
the publisher. When that happens:

- the icon badge turns **orange** with the number of actions
- a notification shows, with two buttons: **Open the site** and **Done**
- the campaign appears under **Actions required** in the popup, with a checkbox

Tick the box (or click "Done" in the notification): the row turns pale green, the orange
badge disappears, and the campaign becomes eligible for farming again even if you enabled
"Ignore campaigns whose account is not linked".

Unticking puts the action back in the pending list: it is reversible, no data is lost.

---

## 5. Diagnosis when an indicator stays red

| Message | Likely cause | What to do |
|---|---|---|
| no answer from the tab | Chrome discarded the tab | `chrome://settings/performance` → add `twitch.tv` to the sites to keep active |
| stream frozen | the stream died without pausing the player | reload the tab, or wait for the next cycle |
| channel offline | the channel stopped | normal, the extension switches on the next cycle |
| tab closed | you closed the pinned tab | it reopens on the next cycle, within a minute |
| wrong channel loaded | a Twitch redirect | rare, corrects itself on the next cycle |

In the service worker console, to see the raw state:

```js
chrome.storage.local.get(null).then(console.log)            // settings, counters, campaigns
chrome.storage.local.get("tabState").then(console.log)     // tabs and window, survives a reload
chrome.storage.session.get("farmState").then(console.log)  // heartbeats and proofs, volatile
chrome.alarms.getAll().then(console.log)                   // the loops
```

The expected alarms are `tdc-tick` (1 min), `tdc-discover`, `tdc-claim` and `tdc-rotate`.

### A window appeared for no reason

```js
chrome.storage.local.get("windowLog").then(console.log)
```

Every creation leaves a line saying **why** the extension decided it had no window. That
is the information the four previous fixes were missing.

| Field | What it says |
|---|---|
| `appelant` | who asked: opening a tab, regrouping, or the button |
| `windowIdMemorise` / `windowIdVivant` | did the extension have an id, and did it point at a window still open |
| `fenetreRetrouveeParMarqueur` | did it find its window through the marked tabs |
| `ongletsMarques` | how many tabs still carry the marker, and in which windows |
| `fenetresNormales` | how many windows Chrome counted at that moment |

A line with `action: "refusee-delai"` means the guard blocked a creation: the extension
cannot find a window it just created, which is itself the symptom to report.

> Reminder: in "separate window" mode, if you close the extension's window it recreates
> one on the next cycle. That is intended, it needs somewhere to put its tabs. To never
> see one appear again, untick the option in the settings: tabs will then go to your
> active window.

---

## 6. After changing the code

```bash
python scripts/build.py
```

Then, on `chrome://extensions`, the **reload** icon (circular arrow) on the card.

Careful: reloading the extension **invalidates already-injected content scripts**. Open
Twitch tabs then show "Extension context invalidated" in their console. That is normal,
not a bug: reload the affected Twitch tabs, or let the extension reopen them on the next
cycle.

> If a newly added interface string shows up as a raw key (`popup_tab_live`), that is
> Chrome's message catalogue cache. Since the fix for
> [#59](../../../issues/59) the extension reads `_locales` itself, so this should no
> longer happen; if it does, remove and re-add the extension.

## 7. Starting from scratch

Service worker console:

```js
chrome.storage.local.clear(); chrome.storage.session.clear();
```

Then reload the extension. Settings go back to defaults, counters to zero, the action
list empties. The **Defaults** button on the settings page does the same without touching
the counters.

---

## What this test does not cover

Behaviour over time, which is the real judge: let it run for an evening on a real
campaign and compare the number of tiers obtained with what Twitch shows at
`twitch.tv/drops/inventory`. A gap means watch time is not being counted as expected, and
the indicator is then what to watch.

The wire formats that come from elsewhere are not covered either: they are tracked in
pinned issue [#56](../../../issues/56), together with everything else CI cannot prove.
