# Manual checks

**The list lives in pinned issue [#56](../../../issues/56), not here.**

It is tickable there, and failures are commented there: that is what makes it
possible to track what is left to do and what is broken. Copying the list into
this file would create a second truth that diverges the first time a box is
unticked.

## Why a manual list exists at all

The Twitch API requires an integrity token that only its own JavaScript can
compute, inside an open page. No automated test can obtain it. So anything that
touches the real network, the player, notifications, or Twitch's actual
behaviour is verified by hand, once, on a real account.

On top of that, some things come from elsewhere and cannot be executed in CI:
the `DropCurrentSessionContext` fingerprint, the `JoinRaid` mutation, the
`raid_update_v2` frames. The pure modules around them are tested; the wire
format itself is only proven on a real session.

## Contribution rule

**Any PR that adds behaviour CI cannot prove adds its section to issue
[#56](../../../issues/56), with its PR number, before merging.**

A section always has the same shape:

- what to do, precisely, and how long to wait;
- what proves it works, observable, not deducible;
- what it looks like when broken, and what to paste in a comment.

A check you could not fail is not a check. Neither is "verify that it works".

## What does not belong there

Whatever CI already covers: the logic in `src/lib/`, manifest permissions, i18n
keys, allowed network exits, and the invariants frozen by regression tests. A
regression there fails before it reaches anyone's hands.
