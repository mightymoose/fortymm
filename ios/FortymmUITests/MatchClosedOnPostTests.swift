//
//  MatchClosedOnPostTests.swift
//  FortymmUITests
//
//  Regression spec for #1651: a score-entry screen left open after the other
//  player finalized the match. The old screen stayed on its form, and the
//  failed post printed the server's "no longer open to results" with nothing
//  more. The app now reads the API's stable `match_closed` code, says the match
//  has finished, and shows the match as it now stands.
//
//  Seeding path, as in `EstablishedRatingMatchDetailTests`: the app mints its
//  own guest session (A). The test process mints guest B over HTTP, has B
//  create an unrated best-of-1 match against A, and later completes it from
//  B's side. A is driven through the UI. Requires a running backend, forwarded
//  through `FMM_API_BASE_URL` the same way as the other UI specs.
//

import XCTest

@MainActor
final class MatchClosedOnPostTests: XCTestCase {
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
        app.launchEnvironment["FMM_API_BASE_URL"] = raw
        app.launch()
    }

    override func tearDownWithError() throws {
        app = nil
    }

    func testPostingToAMatchTheOpponentFinishedShowsTheFinalResult() async throws {
        // 1. Guest A's username, then a match B creates against A.
        let profile = ProfileScreen(app: app)
        profile.open()
        guard let usernameA = profile.username() else {
            XCTFail("Could not read guest A's username off the Profile tab")
            return
        }
        let guestB = try await MatchAPI.mintGuest(baseURL: apiBaseURL)
        let playerA = try await MatchAPI.findPlayer(searcher: guestB, username: usernameA)
        let matchId = try await MatchAPI.createMatch(
            creator: guestB, opponentId: playerA.id, bestOf: 1, rated: false
        )

        // 2. A opens the match and the score screen, and types a deciding score.
        let matches = MatchesListScreen(app: app)
        matches.open()
        let row = matches.row(matchId: matchId)
        XCTAssertTrue(row.waitForExistence(timeout: 15), "Expected a row for the seeded match")
        row.tap()
        let enterScores = app.buttons["Enter scores"]
        XCTAssertTrue(enterScores.waitForExistence(timeout: 15), "Expected the \"Enter scores\" footer action")
        enterScores.tap()

        let fields = app.textFields
        XCTAssertTrue(fields.element(boundBy: 1).waitForExistence(timeout: 15), "Expected both score fields")
        fields.element(boundBy: 0).tap()
        fields.element(boundBy: 0).typeText("11")
        fields.element(boundBy: 1).tap()
        fields.element(boundBy: 1).typeText("5")
        let post = app.buttons["Post result"]
        XCTAssertTrue(post.waitForExistence(timeout: 15), "Expected \"Post result\" once the board decides the match")

        // 3. B finishes the match first. A's screen has no way to know.
        try await MatchAPI.completeUnratedMatch(
            proposer: guestB, matchId: matchId,
            games: [MatchAPI.ResultGame(gameNumber: 1, side1Points: 5, side2Points: 11)]
        )

        // 4. A posts. The app names the reason instead of the server's raw text…
        post.tap()
        let alert = app.alerts["Something went wrong"]
        XCTAssertTrue(alert.waitForExistence(timeout: 15), "Expected the error alert")
        XCTAssertTrue(
            alert.staticTexts["This match has already finished. Here is the final result."].exists,
            "The alert should say the match finished, not repeat the server's raw 409 text"
        )
        alert.buttons["OK"].tap()

        // 5. …and the screen is the match as it now stands, not the dead form.
        XCTAssertFalse(post.waitForExistence(timeout: 5), "The score form's \"Post result\" must be gone")
        XCTAssertTrue(
            app.staticTexts.containing(NSPredicate(format: "label CONTAINS[c] 'Final'")).firstMatch
                .waitForExistence(timeout: 15),
            "Expected the match detail to show the finished match"
        )
    }
}
