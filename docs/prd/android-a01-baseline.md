# Android A01: implementation baseline and iOS workflow inventory

Ticket: [A01.01 #1741](https://github.com/mightymoose/fortymm/issues/1741). Parent: [A01 #1728](https://github.com/mightymoose/fortymm/issues/1728). Umbrella: [#1727](https://github.com/mightymoose/fortymm/issues/1727). PRD: [android-app.md](android-app.md).

This is the durable brief that the A01 subtasks (#1742–#1754) and the player-release tickets (#1729–#1740) follow. It records the agreed decisions and it inventories the iOS app from its source, not its README.

## Agreed platform and identity

- Platform: Kotlin + Jetpack Compose. Native Android controls with TalkBack accessibility.
- App name: FortyMM. Application ID: `com.fortymm.android`.
- Minimum: Android 8.0, API level 26.
- `.dev` and `.qa` builds are isolated installations. The first release and the internal beta use HTTPS UAT only.
- Appearance: dark, matching the current iOS brand palette (ball orange `ball500` on `ink*` surfaces, per [Color+Tokens.swift](../../ios/Fortymm/Tokens/Color+Tokens.swift)). Shared brand tokens. No light mode in this release.
- No nonworking tabs or actions. A destination appears only when its slice lands.
- A01 shows Home read-only: real username, all rating states including absent rating, and recent results. The attention list, the tournament panel, and every other tab stay hidden until their tickets land.

## Implementation defaults

- One Android application module. One feature folder per page-level surface.
- Constructor injection. No DI framework. Small public interfaces.
- Screen state: ViewModel with StateFlow. Concurrency: coroutines.
- One process-wide session owner. All session reads go through it, never a per-screen `GET /v1/session`.
- One centralized HTTP client. Real parsing at the network boundary. Typed errors. Credentials in platform storage, never logged.
- Page-shaped API responses. The device does not recompute ratings, eligibility, or sporting results.
- No new server-side idempotency guarantee for a lost initial guest response.

## Session recovery and refresh rules

- The session loads once at startup, through the owner. First run mints a guest. Overlapping startups and process recreation keep one guest and never create competing identities.
- A revoked or merged session shows an explicit session-ended state. It offers sign-in and continue-as-guest. It never auto-mints a replacement guest (iOS: `SessionStore.signedOut` + `startNewGuest`, [SessionStore.swift:103–126](../../ios/Fortymm/Session/SessionStore.swift)).
- A stale in-flight response must not clear a newer session. iOS does this token-aware (`endIfCurrent`, [SessionTokenStore.swift:120–135](../../ios/Fortymm/Networking/SessionTokenStore.swift)).
- Pending email links stay usable during recovery.
- A failed background refresh keeps the current content visible and allows retry.
- Refetch after identity changes and on app resume. Cancel background polling in the background.
- Saved scores belong to the server scratchpad. Unsubmitted edits stay visibly unsubmitted. Never silently replay a rejected write.

## Home scope in A01

Shown: real username, rating card in all four server states, recent results.

Hidden in #1728, owned by the named ticket:

| Home surface | Owner |
| --- | --- |
| Attention/actionable list | [#1733](https://github.com/mightymoose/fortymm/issues/1733) |
| Live Home updates (SSE hint refetch) | [#1733](https://github.com/mightymoose/fortymm/issues/1733) |
| Home tournament panel integration | [#1738](https://github.com/mightymoose/fortymm/issues/1738) (hidden for #1728) |

iOS source: dashboard fetch at [DashboardStore.swift:65](../../ios/Fortymm/Dashboard/DashboardStore.swift). Rating states at [DashboardModels.swift:116–133](../../ios/Fortymm/Dashboard/DashboardModels.swift). Realtime hint via `GET /v1/stream` in [Realtime/](../../ios/Fortymm/Realtime/). Refresh modifiers in [ViewModifiers.swift](../../ios/Fortymm/Components/ViewModifiers.swift).

## Owner for each A01 acceptance bullet (from #1728)

| #1728 bullet | Owner ticket |
| --- | --- |
| Inventory this file, and settle stack, minimum version, package identity | [#1741](https://github.com/mightymoose/fortymm/issues/1741) (this brief) |
| Clean checkout builds and installs; pinned tooling; CI runs the guest-launch smoke test | [#1742](https://github.com/mightymoose/fortymm/issues/1742), [#1754](https://github.com/mightymoose/fortymm/issues/1754) |
| One guest at first launch; real dashboard; same identity after relaunch; no competing guests | [#1744](https://github.com/mightymoose/fortymm/issues/1744), [#1745](https://github.com/mightymoose/fortymm/issues/1745), [#1746](https://github.com/mightymoose/fortymm/issues/1746), [#1747](https://github.com/mightymoose/fortymm/issues/1747) |
| Centralized networking, typed errors, protected credentials | [#1744](https://github.com/mightymoose/fortymm/issues/1744), [#1748](https://github.com/mightymoose/fortymm/issues/1748), [#1753](https://github.com/mightymoose/fortymm/issues/1753) |
| OpenAPI contract generation and CI drift, nullable fields and unknown enums | [#1753](https://github.com/mightymoose/fortymm/issues/1753) |
| Explicit dev/QA/release selection; test-only auth and insecure transport out of release | [#1743](https://github.com/mightymoose/fortymm/issues/1743) |
| Brand tokens, accessible native controls, only working destinations | [#1742](https://github.com/mightymoose/fortymm/issues/1742), [#1749](https://github.com/mightymoose/fortymm/issues/1749), [#1750](https://github.com/mightymoose/fortymm/issues/1750), [#1751](https://github.com/mightymoose/fortymm/issues/1751) |

## iOS workflow inventory

Classification: **A01** (owner in #1728), **release** (owner in #1729–#1740), or **deferred**.

### Session and sign-in

| Workflow | iOS source | Classification | Owner |
| --- | --- | --- | --- |
| Boot: load or restore session; mint guest once | [SessionStore.swift:130–156](../../ios/Fortymm/Session/SessionStore.swift), [APIClient.swift:103–116](../../ios/Fortymm/Networking/APIClient.swift) | A01 | [#1745](https://github.com/mightymoose/fortymm/issues/1745) |
| Token in Keychain, CSRF double-submit, no credential logging | [SessionTokenStore.swift](../../ios/Fortymm/Networking/SessionTokenStore.swift), [KeychainStore.swift](../../ios/Fortymm/Networking/KeychainStore.swift), [APIClient.swift:340–351](../../ios/Fortymm/Networking/APIClient.swift) | A01 | [#1744](https://github.com/mightymoose/fortymm/issues/1744) |
| Overlapping startup keeps one guest | iOS: `load` re-entrancy guard, [SessionStore.swift:137–155](../../ios/Fortymm/Session/SessionStore.swift) | A01 | [#1746](https://github.com/mightymoose/fortymm/issues/1746) |
| Revoked/merged session: explicit ended state, no auto-guest | [SessionEndedView.swift](../../ios/Fortymm/Login/SessionEndedView.swift), [APIClient.swift:506–524](../../ios/Fortymm/Networking/APIClient.swift) | A01 and release | [#1747](https://github.com/mightymoose/fortymm/issues/1747), then [#1729](https://github.com/mightymoose/fortymm/issues/1729) |
| Email sign-in: request link, check inbox, resend, consume | [LoginService.swift:20–69](../../ios/Fortymm/Login/LoginService.swift), [SignInView.swift](../../ios/Fortymm/Login/SignInView.swift), [CheckInboxView.swift](../../ios/Fortymm/Login/CheckInboxView.swift), [VerifyLoginView.swift](../../ios/Fortymm/Login/VerifyLoginView.swift) | release | [#1729](https://github.com/mightymoose/fortymm/issues/1729) |
| Guest merge gate (bring over / not now) | [MergeGateView.swift](../../ios/Fortymm/Login/MergeGateView.swift), [LoginService.swift:73–75](../../ios/Fortymm/Login/LoginService.swift) | release | [#1729](https://github.com/mightymoose/fortymm/issues/1729) |
| Account switch | [AccountSwitchGateView.swift](../../ios/Fortymm/Login/AccountSwitchGateView.swift), [VerifyLoginView.swift:237–243](../../ios/Fortymm/Login/VerifyLoginView.swift) | release | [#1729](https://github.com/mightymoose/fortymm/issues/1729) |
| Turnstile anti-abuse challenge | [TurnstileView.swift](../../ios/Fortymm/Profile/TurnstileView.swift), used at [SignInView.swift:44](../../ios/Fortymm/Login/SignInView.swift) and [CheckInboxView.swift:79](../../ios/Fortymm/Login/CheckInboxView.swift) | release | [#1729](https://github.com/mightymoose/fortymm/issues/1729) |
| Deep-link landing: login token, confirm-email token | [DeepLink.swift](../../ios/Fortymm/Navigation/DeepLink.swift), [RootView.swift:56–77](../../ios/Fortymm/Navigation/RootView.swift) | release | [#1729](https://github.com/mightymoose/fortymm/issues/1729) |

### Home

| Workflow | iOS source | Classification | Owner |
| --- | --- | --- | --- |
| Rating card, all four states, absent rating | [DashboardModels.swift:116–133](../../ios/Fortymm/Dashboard/DashboardModels.swift), [DashboardWidgets.swift:114](../../ios/Fortymm/Dashboard/DashboardWidgets.swift) | A01 | [#1749](https://github.com/mightymoose/fortymm/issues/1749), [#1750](https://github.com/mightymoose/fortymm/issues/1750) |
| Recent results, empty state | [DashboardWidgets.swift:224](../../ios/Fortymm/Dashboard/DashboardWidgets.swift) | A01 | [#1751](https://github.com/mightymoose/fortymm/issues/1751) |
| Safe refresh on resume and pull | [ViewModifiers.swift:17–99](../../ios/Fortymm/Components/ViewModifiers.swift), [DashboardView.swift:53–83](../../ios/Fortymm/Dashboard/DashboardView.swift) | A01 | [#1752](https://github.com/mightymoose/fortymm/issues/1752) |
| Attention/actionable list | [DashboardAttentionPanel.swift:93–140](../../ios/Fortymm/Dashboard/DashboardAttentionPanel.swift) | release | [#1733](https://github.com/mightymoose/fortymm/issues/1733) |
| Live Home updates via `GET /v1/stream` hint | [RealtimeEvent.swift:33–38](../../ios/Fortymm/Realtime/RealtimeEvent.swift), [DashboardView.swift:73–75](../../ios/Fortymm/Dashboard/DashboardView.swift) | release | [#1733](https://github.com/mightymoose/fortymm/issues/1733) |
| Home tournament panel | [DashboardTournamentPanel.swift](../../ios/Fortymm/Dashboard/DashboardTournamentPanel.swift), [DashboardView.swift:188–190](../../ios/Fortymm/Dashboard/DashboardView.swift) | hidden for #1728; release | [#1738](https://github.com/mightymoose/fortymm/issues/1738) |

### Matches

| Workflow | iOS source | Classification | Owner |
| --- | --- | --- | --- |
| List: status tabs with counts, name search, score-resume chip | [MatchesListView.swift:57–233](../../ios/Fortymm/Matches/MatchesListView.swift) | release | [#1730](https://github.com/mightymoose/fortymm/issues/1730) |
| Detail: participants, games, state, standing result, negotiation state | [MatchDetailView.swift](../../ios/Fortymm/MatchFlow/MatchDetailView.swift), [MatchService.swift:186–189](../../ios/Fortymm/MatchFlow/MatchService.swift) | release | [#1730](https://github.com/mightymoose/fortymm/issues/1730) |
| Create: opponent recent or search, match length, rated toggle, solo | [NewMatchView.swift](../../ios/Fortymm/MatchFlow/NewMatchView.swift), [MatchService.swift:41–49](../../ios/Fortymm/MatchFlow/MatchService.swift) | release | [#1731](https://github.com/mightymoose/fortymm/issues/1731) |
| Scoring: per-game scratchpad, win-by-2, overrun refusal, post unrated/solo | [ScoreEntryView.swift:578–705](../../ios/Fortymm/MatchFlow/ScoreEntryView.swift), [MatchModels.swift:406–529](../../ios/Fortymm/MatchFlow/MatchModels.swift) | release | [#1731](https://github.com/mightymoose/fortymm/issues/1731) |
| Rated negotiation: propose, accept, correct, supersede | [MatchDetailView.swift:95–110](../../ios/Fortymm/MatchFlow/MatchDetailView.swift), [MatchService.swift:62–81](../../ios/Fortymm/MatchFlow/MatchService.swift), [MatchDetailView.swift:519–646](../../ios/Fortymm/MatchFlow/MatchDetailView.swift) | release | [#1732](https://github.com/mightymoose/fortymm/issues/1732) |

### Account and profiles

| Workflow | iOS source | Classification | Owner |
| --- | --- | --- | --- |
| You: identity, email status, claim banner, sign-in row | [ProfileView.swift:99–117](../../ios/Fortymm/Profile/ProfileView.swift) | release | [#1734](https://github.com/mightymoose/fortymm/issues/1734) |
| Change username | [ChangeUsernameView.swift](../../ios/Fortymm/Profile/ChangeUsernameView.swift), [ProfileService.swift:18–23](../../ios/Fortymm/Profile/ProfileService.swift) | release | [#1734](https://github.com/mightymoose/fortymm/issues/1734) |
| Change email: request, resend, confirm (with merge/switch) | [ChangeEmailView.swift](../../ios/Fortymm/Profile/ChangeEmailView.swift), [ConfirmEmailView.swift:282–330](../../ios/Fortymm/Login/ConfirmEmailView.swift), [ProfileService.swift:31–106](../../ios/Fortymm/Profile/ProfileService.swift) | release | [#1734](https://github.com/mightymoose/fortymm/issues/1734) |
| Other player profile and full match history | not implemented in iOS; API paths exist in the OpenAPI schema | release, new in Android | [#1735](https://github.com/mightymoose/fortymm/issues/1735) |

### Tournaments

| Workflow | iOS source | Classification | Owner |
| --- | --- | --- | --- |
| Discovery: list, name search, near-me 25/50/100, status filter, my tournaments | [TournamentsListView.swift](../../ios/Fortymm/Tournaments/TournamentsListView.swift), [TournamentLocation.swift](../../ios/Fortymm/Tournaments/TournamentLocation.swift) | release | [#1736](https://github.com/mightymoose/fortymm/issues/1736) |
| Detail: events, rules, eligibility, venue, reservation windows, tables | [TournamentDetailView.swift](../../ios/Fortymm/Tournaments/TournamentDetailView.swift), [TournamentStore.swift:6–7](../../ios/Fortymm/Tournaments/TournamentStore.swift) | release | [#1736](https://github.com/mightymoose/fortymm/issues/1736) |
| Entry and withdrawal | [TournamentEventView.swift:104–123](../../ios/Fortymm/Tournaments/TournamentEventView.swift), [TournamentStore.swift:15–19](../../ios/Fortymm/Tournaments/TournamentStore.swift) | release | [#1737](https://github.com/mightymoose/fortymm/issues/1737) |
| Draws, standings (incl. Swiss Buchholz), finishes, placements | [TournamentEventView.swift:127–214](../../ios/Fortymm/Tournaments/TournamentEventView.swift) | release | [#1738](https://github.com/mightymoose/fortymm/issues/1738) |
| Schedule: list/tables/players, estimated/called, 15s/3s polling | [TournamentScheduleView.swift](../../ios/Fortymm/Tournaments/TournamentScheduleView.swift), [TournamentDetailView.swift:99–106](../../ios/Fortymm/Tournaments/TournamentDetailView.swift) | release | [#1738](https://github.com/mightymoose/fortymm/issues/1738) |

### Notifications and distribution

| Workflow | iOS source | Classification | Owner |
| --- | --- | --- | --- |
| Push registration, banner, Accept and Suggest-correction actions, match deep link | [PushNotificationManager.swift:93–285](../../ios/Fortymm/Notifications/PushNotificationManager.swift), [FortymmApp.swift](../../ios/Fortymm/FortymmApp.swift) | release | [#1739](https://github.com/mightymoose/fortymm/issues/1739) |
| Signed install (iOS TestFlight fastlane; Android equivalent) | [fastlane/Fastfile](../../ios/fastlane/Fastfile) | release | [#1740](https://github.com/mightymoose/fortymm/issues/1740) |

### Shell and appearance

| Workflow | iOS source | Classification | Owner |
| --- | --- | --- | --- |
| Five-slot tab bar: Home, Matches, New-match action, Tournaments, You | [MainTabView.swift:19–45](../../ios/Fortymm/Navigation/MainTabView.swift) | A01 (Home, matches, You only, as slices land) | [#1742](https://github.com/mightymoose/fortymm/issues/1742) |
| Dark-only palette, forced dark scheme app-wide | [Color+Tokens.swift:12–75](../../ios/Fortymm/Tokens/Color+Tokens.swift), [FortymmApp.swift:13](../../ios/Fortymm/FortymmApp.swift) | A01 | [#1742](https://github.com/mightymoose/fortymm/issues/1742) |

## Deferred, explicitly

- Organizer authoring and controls. iOS has them gated (`tournament.create`, `canEdit`) in [TournamentsListView.swift:36](../../ios/Fortymm/Tournaments/TournamentsListView.swift), [TournamentDetailView.swift:144](../../ios/Fortymm/Tournaments/TournamentDetailView.swift), [TournamentEventView.swift:45](../../ios/Fortymm/Tournaments/TournamentEventView.swift). They do not ship in this Android release.
- Offline queued writes. Confirmed absent from the iOS app. No background queue exists.
- New live spectating. Confirmed absent from the iOS app.

## Gaps flagged, not claimed as parity

- Other-player profiles and full match history do not exist in iOS. #1735 is a new workflow, not a port.
- Sign-out: iOS has no sign-out button. Only the session-ended gate offers continue-as-guest. #1729 should define Android sign-out explicitly.
- iOS match list loads one 50-item page. #1730 sets the Android pagination contract.
- The stale launch-screen paragraph in [ios/README.md:52](../../ios/README.md) (launch renders `DesignSystemView`) does not describe the current app. This inventory supersedes it.

## Source references

- [ios/CLAUDE.md](../../ios/CLAUDE.md)
- [ios/README.md](../../ios/README.md)
- [ios/Fortymm/Navigation/MainTabView.swift](../../ios/Fortymm/Navigation/MainTabView.swift)
- [ios/Fortymm/Navigation/RootView.swift](../../ios/Fortymm/Navigation/RootView.swift)
- [PRD and ticket drafts, android-app.md](android-app.md)
- [Approved Android release scope, #1727](https://github.com/mightymoose/fortymm/issues/1727)
