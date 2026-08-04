# Privacy policy

**Twitch Drops & Points Auto-Claimer**
Last updated: 4 August 2026.

## In one sentence

The extension collects nothing, sends nothing to anyone, and has no server.
Everything it knows stays in your browser.

## What is stored, and where

All of it lives in Chrome's local storage (`chrome.storage`), on your machine.

| Data | Area | Why | Lifetime |
|---|---|---|---|
| Your settings (favourite channels, intervals, quality, volume, language) | `local` | Run the extension the way you asked | Until you uninstall |
| Counters of claimed drops and bonuses | `local` | Shown in the popup | Until you uninstall |
| Claim log: what was claimed, and when | `local` | A counter says how many, never what or when | Last 200 entries |
| The "action required" list and its checkboxes | `local` | Stop telling you about something you already did | Purged 7 days after being ticked |
| Cache of drop campaigns and your progress | `local` | Avoid hammering Twitch in a loop | Refreshed continuously, details purged after 24 h |
| Your Twitch login and account id | `local` | Required by a Twitch API query and by the real-time channel | Until you uninstall |
| Ids of the tabs the extension opened, player state | `session` | The green / red indicator | Cleared when Chrome closes |

Uninstalling the extension wipes all of it; Chrome takes care of that.

## Your Twitch session

To query the Twitch API on your behalf, the extension watches the requests the
Twitch page already sends and reuses seven headers from them, including your
session token and the integrity token Twitch requires. It forges no credential
of its own.

- Those headers are kept **in memory only** (`chrome.storage.session`): cleared
  when Chrome closes, never written to disk.
- Your `Cookie` header is **never** reused nor stored.
- They go to `https://gql.twitch.tv` and `wss://pubsub-edge.twitch.tv`, that is,
  to Twitch itself and nowhere else.
- The extension never asks for your password and never touches a login form.

One consequence: the extension needs at least one open Twitch tab to work. It
opens one itself when needed.

## What the extension watches on the network

To tell you whether Twitch actually counts you as a viewer, the extension
watches, without ever blocking or altering them, two families of requests your
Twitch tabs emit: video segments (`*.ttvnw.net`) and Twitch API requests
(`gql.twitch.tv`). Only the timestamp and the kind are kept, never the content.

## What leaves your machine

Two destinations, both Twitch:

- **`https://gql.twitch.tv`**, the official Twitch API. What is sent: your drop
  campaigns, your progress, the list of live channels, the current drop session,
  joining a raid, and claiming a channel-points chest or a drop.
- **`wss://pubsub-edge.twitch.tv`**, Twitch's own real-time channel. The
  extension subscribes to your own events (a chest becoming available, a drop
  tier landing, a raid starting) and sends nothing beyond that subscription. It
  can be switched off in the settings.

Nothing else. No analytics, no developer server, no telemetry, not even
anonymous. There is no opt-out because there is nothing to opt out of.

## What the extension does not do

- It does not read your browsing history.
- It only acts on `www.twitch.tv`: no other site is within its reach.
- It does not read your messages, your email, your credentials.
- It shares, sells and transmits no data to any third party.

## GDPR

No processing of personal data in the GDPR sense happens on the developer side:
there is no server, no database, no recipient. The data listed above is under
your sole control, on your machine, and you erase it by uninstalling the
extension or clearing its storage from `chrome://extensions`.

## Contact

A question or a doubt about this document: open an issue on the project
repository.
