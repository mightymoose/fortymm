//
//  EstablishedRatingMatchDetailTests.swift
//  FortymmUITests
//
//  Regression spec for #1180: `RatingChangeDTO.delta` used to be a
//  non-optional `Double`, but a player's *first* rated match ESTABLISHES a
//  rating rather than MOVING one (#952) — the API sends a present
//  `rating_change` with `delta: null` for that case (`before` is null too;
//  see `MatchAPI.swift`'s `RatingChangeDTO`). Decoding that with a
//  non-optional `delta` threw for the *entire* match-detail response,
//  producing a dead screen instead of the "Unrated → after" state this spec
//  asserts.
//
//  Seeding path: the app under test mints its own guest session (A) on
//  launch, same as `DashboardEmptyStateTests`. From the *test process*,
//  `MatchAPI` (`Support/MatchAPI.swift`) mints a second guest (B) directly
//  over HTTP, has B search for A and create a rated best-of-1 match, then
//  posts a score as the first proposal. The app itself (guest A) is then
//  driven through the UI — open Matches, tap the seeded match's row, tap
//  "Accept result" — because `finalize_match` (api/app/result_acceptance.py)
//  applies the rating update synchronously inside that same request, so the
//  acceptance response already carries the established `rating_change` with
//  no poll/worker wait needed. This is "Path A" from the ticket's plan: no
//  production-code seam, just a second real participant provisioned from the
//  test side. (Confirmed against a captured payload from a locally-seeded
//  stack — the accept response for a first rated match carries
//  `rating_change: {"before": null, "after": <n>, "delta": null}` for both
//  sides.)
//
//  **Fresh-guest / test-order assumption**, extending `DashboardEmptyStateTests`'
//  own note: this spec asserts (not just assumes) that guest A carries no
//  rating yet — via `MatchAPI.findPlayer`'s `rating` field, straight from
//  `GET /v1/players/search` — before seeding a match that would otherwise
//  silently exercise the MOVED path instead of ESTABLISHED. That precondition
//  holds in CI (`.github/workflows/ios.yml`'s `ui-tests` job) because the
//  runner + simulator are freshly provisioned AND `DashboardEmptyStateTests`,
//  which needs the *same* freshness for its own empty-state assertions, must
//  run before this one in the same `xcodebuild test` invocation (this class
//  gives guest A a completed rated match; Dashboard's empty-state copy would
//  no longer show afterwards). Xcode has no documented ordering guarantee
//  across test classes without an explicit `.xctestplan` — this class is
//  named to sort alphabetically after "Dashboard..." as a best-effort
//  mitigation, and the precondition assertion converts a silent
//  wrong-state pass into a named failure if that ordering ever isn't honored.
//  Flagged to the owning session as a follow-up: pin execution order
//  explicitly (a test plan), or give this spec's guest its own
//  simulator/keychain identity instead of sharing the run's default one.
//
//  Requires a running backend, forwarded the same way as
//  `DashboardEmptyStateTests` — see that file's `setUpWithError` for exactly
//  how `FMM_API_BASE_URL` reaches the launched app process.
//

import XCTest

// `@MainActor`: the test method is `async` (it `await`s `MatchAPI` calls
// directly, no bridging Task), and an `async` XCTest method does not run on
// the main thread by default the way a plain synchronous one always has —
// only `XCUIElement` interactions (`tap()`, etc.) require the main thread,
// but pinning the whole class is simpler than hopping per call.
@MainActor
final class EstablishedRatingMatchDetailTests: XCTestCase {
    /// Fallback backend URL — mirrors `DashboardEmptyStateTests`.
    private static let defaultAPIBaseURL = "http://localhost:8080"

    private var app: XCUIApplication!
    private var apiBaseURL: URL!

    override func setUpWithError() throws {
        continueAfterFailure = false

        let raw = ProcessInfo.processInfo.environment["FMM_API_BASE_URL"] ?? Self.defaultAPIBaseURL
        guard let url = URL(string: raw) else {
            XCTFail("FMM_API_BASE_URL (\"\(raw)\") is not a valid URL")
            return
        }
        apiBaseURL = url

        app = XCUIApplication()
        // See DashboardEmptyStateTests.setUpWithError for why this has to be
        // copied onto launchEnvironment explicitly rather than just being
        // set in this test process's own environment.
        app.launchEnvironment["FMM_API_BASE_URL"] = raw
        app.launch()
    }

    override func tearDownWithError() throws {
        app = nil
    }

    func testFirstRatedMatchEstablishesRatingOnAccept() async throws {
        // 1. Read the app-minted guest's (A's) own username off the Profile tab.
        let profile = ProfileScreen(app: app)
        profile.open()
        guard let usernameA = profile.username() else {
            XCTFail("Could not read guest A's username off the Profile tab")
            return
        }

        // 2. Seed a rated match from the test process: mint guest B, resolve
        //    A's id + current rating via the opponent typeahead, and assert
        //    the freshness precondition (see file header) before creating
        //    the match and posting the first proposal.
        let guestB = try await MatchAPI.mintGuest(baseURL: apiBaseURL)
        let playerA = try await MatchAPI.findPlayer(searcher: guestB, username: usernameA)
        XCTAssertNil(
            playerA.rating,
            "Guest A (\(usernameA)) already carries a rating -- this spec needs a guest whose "
                + "first-ever rated match is the one it's about to seed, or the assertions below "
                + "would silently exercise the MOVED path instead of ESTABLISHED. See this file's "
                + "header for the test-class execution-order assumption this depends on."
        )

        let matchId = try await MatchAPI.createMatch(
            creator: guestB, opponentId: playerA.id, bestOf: 1, rated: true
        )
        _ = try await MatchAPI.proposeResult(
            proposer: guestB, matchId: matchId,
            games: [MatchAPI.ResultGame(gameNumber: 1, side1Points: 11, side2Points: 5)]
        )

        // 3. Drive the app itself (guest A) to the seeded match and accept it.
        let matches = MatchesListScreen(app: app)
        matches.open()
        let row = matches.row(matchId: matchId)
        XCTAssertTrue(
            row.waitForExistence(timeout: 15),
            "Expected a row for the freshly-seeded match (\(matchId)) to appear in the Matches list"
        )
        row.tap()

        let detail = MatchDetailScreen(app: app)
        XCTAssertTrue(
            detail.acceptResultButton.waitForExistence(timeout: 15),
            "Expected the \"Accept result\" footer action on the freshly-proposed match"
        )
        detail.acceptResultButton.tap()

        // 4. Assert the established-rating state: "Unrated -> after", no
        //    delta chip, no moved card, and the seeded 1500 nowhere on screen.
        XCTAssertTrue(
            detail.establishedRatingCard.waitForExistence(timeout: 15),
            "Expected the established-rating card after accepting guest A's first rated match"
        )
        let label = detail.establishedRatingCard.label
        XCTAssertTrue(
            label.contains("Unrated") && label.contains("now rated"),
            "Established card's accessible label should read "
                + "\"Unrated before this match, now rated <after>\"; got: \"\(label)\""
        )
        XCTAssertFalse(
            detail.movedRatingWasLine.exists,
            "The moved-rating card's \"was <before>\" line must not render alongside the "
                + "established one — an established rating has no prior value to have been at"
        )
        XCTAssertFalse(
            detail.ratingDeltaText.exists,
            "An established rating must show no signed delta chip"
        )
        XCTAssertFalse(
            detail.hasVisibleLiteral1500(),
            "The seeded 1500 must never render on this screen as if it were an earned rating (#952)"
        )
    }
}
