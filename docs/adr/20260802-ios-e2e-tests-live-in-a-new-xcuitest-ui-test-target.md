# iOS E2E tests live in a new XCUITest UI test target

`ios/CLAUDE.md` previously stated "one app target, zero XCTest, ever" — no test
target existed because none had been needed yet. Adding end-to-end coverage
requires driving real screens through the Simulator, which only a UI test
target (XCUITest) can do; a lighter unit-only XCTest target was considered and
rejected because it can't exercise actual taps/navigation and so wouldn't be
"end to end" in the sense the rest of the repo uses that word (root `e2e/`
drives the real UI against a real backend, no mocks).

Conventions for the new target, chosen to mirror the existing Playwright
suites rather than invent new ones:

- **Screen objects**, one Swift type per screen wrapping `XCUIElement`
  queries/actions — the XCUITest analog of `e2e/page-objects/DashboardPage`.
- **Explicit `.accessibilityIdentifier()`** on the views a spec touches, added
  incrementally as screens gain coverage, rather than matching on visible
  text/labels. No view in the app set one before this decision.
- Specs target the **real backend** (guest session via `GET /v1/session`,
  same auto-provision behavior as web), not a mocked network layer — iOS has
  no MSW equivalent.

The first spec is deliberately narrow: launch → guest session mints →
Dashboard renders its empty state for a fresh guest. It needs no seeded data and
proves the pipeline (test target, screen objects, backend wiring, CI) end to
end before more flows are added. Full magic-link login automation is out of
scope for this decision — there's no email-capture (Mailpit-equivalent) wired
into the dev backend yet.

**Correction (same day, during `/do-chores`):** the first spec was originally
written against web's single "Log your first match." hero
(`web-client/src/components/dashboard/first-match/`), assumed without checking
the iOS view code. iOS has no such hero — `DashboardView.swift` always renders
the normal "Your game" section. A fresh guest instead sees two independent,
already-existing empty states once loaded: the rating card reads "Unrated —
finish a rated match to start your rating" (`DashboardView.swift:218`) and the
recent-results card reads "No completed matches yet."
(`DashboardWidgets.swift:254`). The first spec targets these two instead —
still zero seeded data, still deterministic, still proves the same pipeline.
Building a web-parity first-match hero on iOS is out of scope for this arc.
