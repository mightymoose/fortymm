# Unread is a per-visit snapshot over auto-marked notifications

Date: 2026-07-24

## Status

Accepted

Numbered by date, following the `20260722-*` ADRs, not by incrementing the highest
file on disk — parallel worktrees each number off a stale main, which has already
produced four `0008`s.

## Context

Three QA-filed bugs (#996, #999, #1112) and one descope decision (#998) all turn on
a single unresolved question the notifications feature never answered out loud:
**when does a notification become "read"?**

Today a notification is marked read the moment its row scrolls ≥50% into view — an
`IntersectionObserver` (`use-seen-on-screen.ts`) feeds a debounced batch
mark-read (`use-auto-mark-read.ts`), on both the `/notifications` page and the bell
dropdown. On a short list, everything visible is read within 800ms of arrival.

That eager auto-mark is *convenient* — you never have to click a notification to
clear it — and we chose to keep it (a per-item "click to dismiss" was rejected as
annoying). But it makes a naive **Unread** filter (`read_at IS NULL`) empty by
construction: by the time you can click the Unread pill, nothing is unread. #762
added a "sticky unread" mechanism to keep just-auto-read rows visible under Unread,
but scoped it to *rows seen while the Unread filter was already active* — so
arriving on the default **All** filter (the normal case) marks everything read
before the snapshot is ever taken, and Unread is empty anyway.

The related failures:

- **#996** — Unread can never show anything; the pill is decorative.
- **#1112** — the bell badge goes stale: it does not reliably decrement as rows
  auto-read.
- **#999** — the active filter lives in component state, not the URL, so a filtered
  view can't be linked and doesn't survive reload.
- **#998** — the `rating_change` category is seeded (pill + preferences row) but
  **nothing ever emits it**, and the result-poster gets no "accepted" notification.
  Building that fan-out is its own feature; see the descope below.

## Decision

**Auto-mark-on-view stays. "Unread" is redefined as a per-visit snapshot: the set
of notifications that were unread at the moment you arrived on this surface.** The
snapshot is taken on arrival (page mount / bell open) regardless of which filter
you land on, and those rows remain visible under the Unread filter for the visit
even after auto-mark flips their `read_at`.

This is #762's sticky mechanism, generalized: the snapshot is no longer gated on
the Unread filter being active when a row is seen — it is captured up front, once,
per visit. Leaving and returning (or reloading) takes a fresh snapshot.

Consequences of the redefinition:

- **"Unread" means "new since you got here," not "never opened."** That is what
  most people already read the pill as, and it is the only meaning compatible with
  keeping auto-mark. A row read on another device, or on a previous visit, is not
  in this visit's snapshot and correctly does not appear.
- **The badge counts true unread (`read_at IS NULL`) and drains as rows auto-read.**
  It is not driven by the snapshot. #1112 is fixed by making the optimistic
  decrement / invalidation reliable, independent of this redefinition — the badge
  and the Unread pill answer two different questions and are allowed to disagree.
- **The active filter moves into the URL** (`?filter=…`), Zod-parsed at the route
  boundary via `validateSearch`, per the web-client Boundaries convention (#999).
  A shared/reloaded `?filter=unread` link takes its snapshot at load time, so it is
  self-consistent.

### Descope: rating/result-accepted notifications (#998)

Emitting a notification when a result is accepted, or when a rating changes, is a
domain-event fan-out feature with its own design surface (what counts as a
rating-change event, per-match vs digest, copy, read semantics). It is **out of
scope** here. Until it exists, the `rating_change` category is hidden **client-side
from both surfaces it renders on** — the filter pills and the preferences matrix —
so users never see a pill or a channel toggle for a notification that cannot
arrive. The category remains defined and seeded server-side; the follow-up feature
un-hides it by flipping one predicate. A tracking issue carries the fan-out work.

## Consequences

- **The sticky mechanism is generalized, not deleted.** `use-sticky-unread.ts`
  keeps pinning auto-read rows under Unread; the change is *when* it starts
  snapshotting (arrival, any filter) rather than (first seen while on Unread).
- **"Unread" is explicitly a session/visit concept.** A row does not stay under
  Unread forever — a return visit re-snapshots. This is deliberate: a durable
  "never opened" state is incompatible with auto-mark-on-view, and we chose
  auto-mark.
- **Hiding `rating_change` is a client filter over the server taxonomy**, not a
  taxonomy change. No schema churn, no regen; the follow-up feature reverts it in
  one place. If a `rating_change` notification somehow already exists in a feed, it
  still renders in the row list — we only suppress the pill and the pref toggle,
  which are the decorative-when-empty surfaces.
