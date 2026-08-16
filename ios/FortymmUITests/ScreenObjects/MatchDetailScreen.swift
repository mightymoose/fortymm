//
//  MatchDetailScreen.swift
//  FortymmUITests
//
//  Screen object for the match-detail screen
//  (`Fortymm/MatchFlow/MatchDetailView.swift`). See
//  docs/adr/20260802-ios-e2e-tests-live-in-a-new-xcuitest-ui-test-target.md
//  for the screen-object + accessibilityIdentifier convention this follows.
//

import XCTest

/// Wraps the match-detail screen's `XCUIElement` queries/actions — in
/// particular the two mutually-exclusive "Your rating" renderings (#1180):
/// `established` (a first rated match — `Unrated → after`, no delta/color/
/// sparkline) and `moved` (`before → after` with a signed delta), which never
/// both exist on screen at once.
struct MatchDetailScreen {
    private let app: XCUIApplication

    init(app: XCUIApplication) {
        self.app = app
    }

    /// The footer's primary "Accept result" action
    /// (`MatchDetailView.swift`'s `acceptFooter`, tagged
    /// `matchDetail.footer.acceptResult`).
    var acceptResultButton: XCUIElement {
        app.buttons["matchDetail.footer.acceptResult"]
    }

    /// The established-rating card: a single, non-decomposed accessibility
    /// element (`.accessibilityElement(children: .ignore)`) whose `label` is
    /// "Unrated before this match, now rated <after>" — read the label
    /// rather than querying sub-elements, since the combine deliberately took
    /// them out of the tree (mirrors the web's aria-label on the established
    /// `RatingRow`).
    var establishedRatingCard: XCUIElement {
        app.otherElements["matchDetail.rating.established"]
    }

    /// The moved-rating card's "was <before>" line — the marker for the moved
    /// rendering (`before → after`, signed delta, sparkline).
    ///
    /// This queries the `was …` `Text`, not the card's container, on purpose.
    /// The container is not an accessibility element: unlike
    /// `establishedRatingCard` it does not combine its children, because doing
    /// so would change what VoiceOver reads on the moved path. An identifier
    /// on it would therefore never match, and an `exists` check against it
    /// would be vacuously false — passing whether or not the moved card
    /// rendered, which is worse than no assertion at all.
    var movedRatingWasLine: XCUIElement {
        app.staticTexts["matchDetail.rating.moved.was"]
    }

    /// The moved card's signed delta chip — present only inside
    /// `movedRatingCard`, so its absence is part of what proves the
    /// established rendering never leaks a delta.
    var ratingDeltaText: XCUIElement {
        app.staticTexts["matchDetail.rating.delta"]
    }

    /// Sweeps every static text on screen for a literal "1500" — the seeded
    /// rating a fresh guest never actually held (#952). Used as a whole-
    /// screen negative assertion, not scoped to the rating section, since the
    /// bug this guards was a fallback that could in principle leak anywhere
    /// `MatchPlayer.rating` reaches a label.
    func hasVisibleLiteral1500() -> Bool {
        app.staticTexts.matching(NSPredicate(format: "label CONTAINS '1500'")).count > 0
    }
}
