//
//  FortymmUITests.swift
//  FortymmUITests
//
//  Scaffold smoke test proving the FortymmUITests target is wired up correctly:
//  launches the app and asserts it comes to the foreground without crashing.
//  Real screen-object-based specs land in a later chore (see
//  docs/adr/20260802-ios-e2e-tests-live-in-a-new-xcuitest-ui-test-target.md).
//

import XCTest

final class FortymmUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testAppLaunchesWithoutCrashing() throws {
        let app = XCUIApplication()
        app.launch()

        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 5))
    }
}
