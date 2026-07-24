# iOS data freshness is navigation-driven, not realtime

The native app was showing stale data "for too long": returning to the Home
tab from Matches left the dashboard showing an already-resolved "needs your
attention" row, and returning to the matches list from a match detail left the
tapped row stale. The data-bearing screens (`DashboardView`, `MatchesListView`)
own an in-place-refreshing store/state and *try* to refetch on re-appearance,
but they hang that refetch off SwiftUI `.onAppear`, which fires **unreliably on
`TabView` tab-return** (Matches→Home reproducibly did not refetch the dashboard,
even though the symmetric Home→Matches did). The store itself is correct —
`DashboardStore.load(force: true)` always refetches in place — so the defect is
the *trigger*, not the fetch.

We decided freshness on iOS is, for now, **navigation- and visibility-driven,
made deterministic** — not realtime:

- **Tab-return refetch is driven off the `TabView` `selection` binding**, which
  `MainTabView` owns, rather than `.onAppear`. "The selected tab just became
  Home → reload the dashboard" (and the same for the matches list) fires every
  time, on a signal the app controls, instead of relying on `.onAppear`'s
  `TabView` quirk. First-load moves to `.task`; tab-returns ride the selection
  change, so there is exactly one refetch per return and no double-fetch.
- **The matches list refetches when a match-detail cover is dismissed**, mirror-
  ing the hook `DashboardView` already has on its detail/resume covers. This is
  a *separate* fix from the selection-driven one: the detail is a
  `fullScreenCover` presented *over* the matches list within the same tab, so
  returning from it never changes tab selection.

## Considered options

- **Deterministic navigation/visibility refetch (chosen).** Refetch on the
  signals the app already controls — tab selection and cover dismissal. Fixes
  the observed staleness with no server changes and no ongoing request cost, and
  removes the dependency on `.onAppear`'s unreliable tab-return behavior.
- **Lightweight foreground polling.** Refetch the visible tab every ~20s while
  active. Would additionally cover *cross-device* changes to a screen you are
  actively looking at (the opponent posts a result while you sit on the
  dashboard). **Deferred** — see below.
- **Just make `.onAppear` fire reliably.** Rejected: `.onAppear`-on-tab-return
  in `TabView` is the exact flakiness that caused the bug; it is not a
  foundation to rest a freshness guarantee on.
- **Full live channel (SSE/WebSocket) now.** Rejected as out of scope for a
  staleness bugfix; it is the right long-term answer but a large, cross-platform
  effort (see below).

## Consequence

The two reported staleness bugs are fixed deterministically. What this
**explicitly does not do** is keep a *visible* screen fresh against changes made
on another device — if you sit on the dashboard and your opponent posts a
result, you still won't see it until you leave and return, pull to refresh, or
background/foreground. That "live" gap is a **deliberate non-goal here**: it is
slated for a dedicated, cross-platform realtime effort (web **and** iOS,
in-progress matches, iOS Live Activity) rather than an iOS-only polling
stopgap. Anyone tempted to add polling to close the gap should do it as part of
that effort, not bolt it on here — that is why this refetch is navigation-driven
and stops there.
