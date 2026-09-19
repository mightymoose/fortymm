# Android app — proposed scope and ticket drafts

Status: scope and breakdown approved; published as [Android parent #1727](https://github.com/mightymoose/fortymm/issues/1727) with 13 child issues on 2026-09-16. Planning only; implementation has not started.

## Release scope

Proposed first release: a native Android player app using the existing FortyMM API and the iOS player experience as its baseline. Players can keep a guest identity, sign in, create and score matches, negotiate results, manage their account, and participate in tournaments. Home, Matches, New match, Tournaments and You are the primary destinations/actions.

Proposed implementation direction: Kotlin and Jetpack Compose, feature-oriented screen state, centralized networking and session ownership, and OpenAPI-backed contract checking. These are planning proposals, not accepted architecture decisions. Resolve Android support floor, package identity, tool versions, link domains, notification credentials and distribution access in the relevant tickets before implementation is marked ready.

Organizer authoring, offline score submission/queued mutations, new live-spectating capabilities, and new backend sporting rules are outside this proposed release. Do not promise full iOS parity until the feature inventory in A01 is agreed; iOS already includes some organizer controls.

Use GitHub Issues and the existing FortyMM project workflow. Drafts with unresolved scope belong in To Do, not Ready For Implementation. Preserve the existing tracker configuration rather than introducing a second triage vocabulary.

## Shared acceptance requirements

- Existing API schemas, capability flags, error codes, glossary and accepted ADRs are authoritative. Resolve disagreements between clients against these contracts.
- Reuse page-shaped API responses. Do not reproduce rating calculations, eligibility, sporting results or authority rules on the device.
- Each feature includes loading, empty, missing-resource, error and retry behavior; TalkBack labels, large text and reachable controls; and Android back/lifecycle behavior.
- Keep successful content visible during a failed background refresh. Refetch after identity changes and app resume as appropriate; cancel background polling.
- Saved scores belong to the server scratchpad. Clearly distinguish unsubmitted edits from saved state; never silently replay rejected writes after session recovery.
- Each ticket includes focused automated checks and an end-to-end demonstration against an isolated backend. Cover rotation/process recreation where state loss could change identity, intent or a submitted action.
- API changes, if required, preserve web/iOS compatibility and regenerate their reference types. Existing merged migrations are immutable.

## Proposed sequence

| Ticket | Deliverable | Blocked by |
| --- | --- | --- |
| A01 | Launch into a real guest Home screen | None |
| A02 | Sign in by email and recover identity safely | A01 |
| A03 | Find and inspect matches | A01 |
| A04 | Create and score an unrated or solo match | A03 |
| A05 | Play a rated match and negotiate its result | A02, A04 |
| A06 | Find actionable matches from Home | A05 |
| A07 | Manage username and email | A02 |
| A08 | View player profiles and full match history | A03 |
| A09 | Discover tournaments and inspect events | A01 |
| A10 | Enter and withdraw from tournament events | A02, A09 |
| A11 | Follow tournament draws, results and schedules | A03, A09 |
| A12 | Receive and act on match notifications | A05 |
| A13 | Install and validate a signed internal beta | A06–A08, A10–A12 |

Branches after A01 can proceed independently as their blockers complete. The match-playing milestone is A01–A05; the proposed player release includes every ticket below.

## A01 — Launch Android into a real guest Home screen

### What to build

Establish the Android app with a complete first-launch path: create/restore the API-backed guest session and show the real dashboard in FortyMM styling. Include the build and test infrastructure needed to keep this working.

### Acceptance criteria

- [ ] Record an explicit inventory of iOS player workflows and classify each as included, deferred or covered by a named ticket; settle the proposed native stack, minimum Android version and package identity.
- [ ] A clean checkout builds and installs on a supported emulator using documented, pinned tooling; CI builds and executes the guest-launch smoke test.
- [ ] First launch bootstraps a guest once, renders real dashboard data and retains the same identity after relaunch; concurrent startup requests do not create competing identities.
- [ ] Centralized networking decodes actual API data, surfaces typed errors, and protects credentials in platform-appropriate storage without logging them.
- [ ] Add reproducible OpenAPI contract generation/checking and CI drift detection, including nullable fields and unknown enum behavior.
- [ ] Dev/QA and release environment selection is explicit; test-only authentication and insecure transport cannot reach the release build.
- [ ] Use shared brand tokens and accessible native controls; show only working destinations until their slices land.

### Blocked by

None — can start after scope review.

## A02 — Sign in by email and recover identity safely

### What to build

Complete the existing email sign-in journey on Android, including guest merge decisions, account switches, sign-out and revoked-session recovery.

### Acceptance criteria

- [ ] Request an email link through the existing anti-abuse flow and consume it on cold or warm app launch; verified link association and browser fallback are documented and tested.
- [ ] Expired/used links, network failures and server refusal codes produce the appropriate distinct recovery path without losing retryable intent.
- [ ] Account-switch approval and guest-merge choices follow server previews; cancel preserves identity, preview failure never implies consent, and a changed source account requires renewed approval.
- [ ] Persist the signed-in session across relaunch; sign-out clears account-specific data and device association as supported by the API.
- [ ] Revocation presents an explicit session-ended state, not an automatically created replacement guest. Pending email links remain usable during recovery.
- [ ] Exercise a real email round trip through QA Mailpit, plus cold-start, retry and identity-switch cases.

### Blocked by

A01.

## A03 — Find and inspect matches

### What to build

Deliver the Matches destination with search/filtering, pagination and read-only match details for the API-authorized audience, including incoming shared match links.

### Acceptance criteria

- [ ] Search, status filters, counts and pagination match API semantics; a global match feed is not accidentally narrowed to the current player.
- [ ] Details show participants, games, match state, standing result and official outcome accurately, including solo, scheduled, voided and missing matches.
- [ ] Participant and spectator capabilities remain distinct; spectators never gain scoring or acceptance actions.
- [ ] Share links resolve to the same match on warm/cold start and have an appropriate browser fallback; Back returns to the prior list/filter state.
- [ ] Failed refreshes retain prior content and allow retry; link and list routes exercise the same detail behavior.

### Blocked by

A01.

## A04 — Create and score an unrated or solo match

### What to build

Make the New match action deliver a complete unrated match: choose an opponent or solo play, create it, maintain its shared scratchpad, and record the result.

### Acceptance criteria

- [ ] Create permitted unrated and solo matches with the existing rules/settings; disable duplicate submissions while a create request is in flight. The current create contract has no client idempotency key, so after a lost response Android must retain and explain the uncertain outcome rather than infer the created match from the global feed; any later retry is an explicit new create attempt.
- [ ] Read, save and clear individual games through the canonical server scratchpad. Reopening a match shows server-saved scores across clients.
- [ ] Enforce contiguous scoring and decided-board requirements; reject games after the decider instead of silently trimming them.
- [ ] Recording an unrated result completes through the existing API without waiting for opponent acceptance; solo games retain the No opponent side.
- [ ] Permission changes, network failure and session expiry preserve an honest saved/unsaved state. Rotation/recreation cannot re-submit an in-flight create or silently submit an edit; a lost create response remains an explicit uncertain state.
- [ ] Demonstrate Android scoring followed by verification from another client against the same backend.

### Blocked by

A03.

## A05 — Play a rated match and negotiate its result

### What to build

Extend the playable flow to rated matches with a real opponent, result proposal, acceptance and full-board correction.

### Acceptance criteria

- [ ] Only valid opponent/rating combinations can be created; server authorization and refusal reasons are preserved.
- [ ] The first proposal freezes the scratchpad. Corrections submit a complete legal board as a new immutable proposal.
- [ ] The opponent accepts the exact proposal displayed. A superseding result forces a fresh review instead of accepting a newer unseen score.
- [ ] Distinguish waiting on the opponent, awaiting the player's response and completed matches; reflect the server's retirement window and resolution without presenting silence as human acceptance.
- [ ] Official outcomes and proposal history render from server data, including later administrator revisions; Android adds no organizer correction capability in this slice.
- [ ] Two identities across Android and web/iOS can propose, correct and accept; concurrent corrections, stale acceptance, duplicate taps and interrupted responses are covered.

### Blocked by

A02, A04.

## A06 — Find actionable matches from Home

### What to build

Connect Home's first-match and attention states to the completed match flows so a player can find and perform their next action.

### Acceptance criteria

- [ ] First-match state starts the creation flow; actionable score/review items open the correct match action.
- [ ] Waiting-on-opponent and waiting-on-others items are not presented as player tasks.
- [ ] View all carries the intended filter into Matches and does not leak a previous account's state.
- [ ] Returning from scoring, proposing or accepting refreshes counts and actions; background/resume behavior follows the established lifecycle rules.

### Blocked by

A05.

## A07 — Manage username and email

### What to build

Deliver the You account settings experience using existing username and email-change flows.

### Acceptance criteria

- [ ] Username updates surface server validation and uniqueness errors and refresh shared session state after success.
- [ ] Email request, pending address, resend and confirmation follow the current API; expiry does not erase durable pending intent.
- [ ] Replaced confirmation links direct the player to the newer email rather than automatically resending again.
- [ ] Confirmation handles guest merges, account switches and session rotation through A02's identity flow.
- [ ] Cold/warm confirmation links, unavailable addresses, throttling and relaunch during a pending change have automated coverage.

### Blocked by

A02.

## A08 — View player profiles and full match history

### What to build

Let a player open their own or another player's profile and navigate into that person's full match history.

### Acceptance criteria

- [ ] Profile presentation respects viewer-specific visibility and actions from the API.
- [ ] Rating, rank, peak and confidence remain league-scoped; career totals are cross-league and do not misrepresent undecided matches as wins/losses.
- [ ] Unrated and insufficient-data states remain explicit rather than inventing a displayed rating.
- [ ] Full match history is a separate paginated destination, not a truncated profile sample; selecting a row opens A03 details.
- [ ] Missing or retired player behavior follows the current server contract; league changes and pagination cannot mix stale results.

### Blocked by

A03.

## A09 — Discover tournaments and inspect events

### What to build

Deliver tournament discovery and player-readable tournament/event detail, including optional nearby search.

### Acceptance criteria

- [ ] Search tournaments by name/status and paginate the result. `GET /v1/tournaments` currently returns a bare list with only a near-me filter and no page contract, so the API change for a page-shaped tournament list is owned by this ticket: define and ship the server-side name/status filter plus pagination contract before relying on it.
- [ ] Near me is opt-in, supports the existing 25/50/100-mile choices and distance display, and leaves ordinary search usable when location is denied or unavailable.
- [ ] Show event rules, eligibility explanations, venue/map links, reservation windows and public table information.
- [ ] Tournament publication and event progress are rendered as separate concepts; unsupported or unavailable data does not fabricate a status.
- [ ] Organizer-only actions are absent from this player scope; links and native Back retain useful discovery state.

### Blocked by

A01.

## A10 — Enter and withdraw from tournament events

### What to build

Let an eligible signed-in player enter an event, see their entry and withdraw when the registration policy permits.

### Acceptance criteria

- [ ] Entry controls use server-calculated eligibility, capability flags and machine-readable refusal codes; do not rederive eligibility from rating fields.
- [ ] Successful entry/withdrawal refreshes the player's state, entrant list and capacity display.
- [ ] Full capacity, registration closure, cancelled event, duplicate entry and identity change show correct recoverable feedback.
- [ ] Registration policy remains separate from event progress; an unstarted event in a live tournament does not imply open registration.
- [ ] A capacity race between two clients respects the server outcome and produces no phantom local entry.

### Blocked by

A02, A09.

## A11 — Follow tournament draws, results and schedules

### What to build

Provide player-readable stages/groups, fixtures, results and schedules with links into match details and participant scoring when available.

### Acceptance criteria

- [ ] Render the currently supported draw types with their server-provided standings/finishes, including Swiss Buchholz, byes and unresolved fixture sides.
- [ ] Show schedules as readable native lists grouped by table/player, including placements, estimated/called states and reservation warnings.
- [ ] Fixture navigation handles matches not yet materialized; scheduled or uncalled matches do not acquire unauthorized scoring actions.
- [ ] Reflect official-result changes and updated schedules after refresh without recalculating sporting outcomes locally.
- [ ] Match the existing active schedule refresh policy (15 seconds live; 3 seconds while a solve is queued/running), stop in background and refresh on return.

### Blocked by

A03, A09. Participant scoring uses A04/A05 once available.

## A12 — Receive and act on match notifications

### What to build

Add Android push delivery end to end, from backend match events through device registration and delivery to the correct in-app review/action.

The current backend registration schema only accepts iOS and its sender is APNs-based. This is a cross-layer feature, not merely Android notification UI.

### Acceptance criteria

- [ ] Record the Android delivery/provider and credential setup, then add platform-aware registration and sending while preserving iOS behavior; use forward migrations if needed.
- [ ] Permission denial leaves in-app match review fully usable. Registration handles token rotation, logout/account switch and invalid-device cleanup without delivering another account's private events.
- [ ] A delivered notification opens the referenced match/result on cold and warm start; revoked sessions route through explicit recovery.
- [ ] Any acceptance action binds to the exact result shown; stale proposals, wrong-account use and duplicate delivery cannot accept a different result.
- [ ] Cover provider success, transient failure and invalid tokens with automated tests, plus real delivery to an authorized Android test device.

### Blocked by

A05; Android delivery credentials/test device must be available for live verification.

## A13 — Install and validate a signed internal beta

### What to build

Produce a repeatable signed Android beta and verify the agreed player journeys from an actual installed release build.

### Acceptance criteria

- [ ] Resolve the internal distribution destination, signing custody and release environment; document and automate a reproducible versioned release artifact with secrets outside source control.
- [ ] A tester can install the beta, complete sign-in, play/review a match, manage their account and enter/follow a tournament against the intended environment.
- [ ] Release signing identities are included in verified link configuration; email/share links and notification entry work in the distributed build.
- [ ] Exercise upgrades without losing the session, the declared minimum Android version, a current device/emulator, TalkBack, large text, back navigation and interrupted connectivity.
- [ ] Maintain a small cross-client regression suite against an isolated backend covering guest recovery, shared scoring, stale result acceptance and tournament entry.
- [ ] Record remaining issues and release evidence; public store launch remains a separate decision with its own current submission requirements.

### Blocked by

A06, A07, A08, A10, A11, A12; signing and distribution access.

## Source references

- [Domain glossary](../../CONTEXT.md)
- [iOS feature baseline](../../ios/README.md) and [native conventions](../../ios/CLAUDE.md)
- [Session recovery](../adr/20260904-session-eviction-requires-explicit-identity-recovery.md)
- [Durable email intent](../adr/20260907-email-action-intent-outlives-its-credentials.md)
- [Immutable proposals](../adr/20260906-proposals-form-an-immutable-linear-history.md)
- [Immutable official results](../adr/20260911-official-results-have-immutable-revisions.md)
- [Notification acceptance binding](../adr/0007-approve-push-binds-to-the-result-it-showed.md)
- [Profile scope](../adr/0915-the-profile-is-league-scoped-for-rating-and-cross-league-for-career.md)
- [Entry refusal codes](../adr/0968-entry-refusals-are-machine-readable-codes-not-prose.md)

## Published tickets

Scope and ticket breakdown approved on 2026-09-16. GitHub issues are the working source for subsequent discovery and implementation planning.

- parent: [#1727](https://github.com/mightymoose/fortymm/issues/1727)
- A01: [#1728](https://github.com/mightymoose/fortymm/issues/1728)
- A02: [#1729](https://github.com/mightymoose/fortymm/issues/1729)
- A03: [#1730](https://github.com/mightymoose/fortymm/issues/1730)
- A04: [#1731](https://github.com/mightymoose/fortymm/issues/1731)
- A05: [#1732](https://github.com/mightymoose/fortymm/issues/1732)
- A06: [#1733](https://github.com/mightymoose/fortymm/issues/1733)
- A07: [#1734](https://github.com/mightymoose/fortymm/issues/1734)
- A08: [#1735](https://github.com/mightymoose/fortymm/issues/1735)
- A09: [#1736](https://github.com/mightymoose/fortymm/issues/1736)
- A10: [#1737](https://github.com/mightymoose/fortymm/issues/1737)
- A11: [#1738](https://github.com/mightymoose/fortymm/issues/1738)
- A12: [#1739](https://github.com/mightymoose/fortymm/issues/1739)
- A13: [#1740](https://github.com/mightymoose/fortymm/issues/1740)
