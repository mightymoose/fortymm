import Foundation
import SwiftUI
import Testing
import UIKit
@testable import FortyMM

struct DesignTokenTests {
    // The simulator runs on the Mac, so the test can read the checkout.
    static let reference = URL(filePath: #filePath)
        .deletingLastPathComponent()
        .appending(path: "../../references/design-system/colors_and_type.css")
        .standardized

    @Test(arguments: DesignToken.allCases)
    func matchesTheReference(token: DesignToken) throws {
        let css = try String(contentsOf: Self.reference, encoding: .utf8)
        let pattern = try Regex("--\(token.rawValue):\\s*#([0-9A-Fa-f]{6});")
        let match = try #require(css.firstMatch(of: pattern), "--\(token.rawValue) isn't in \(Self.reference.path)")
        let hex = try #require(UInt32(match.output[1].substring!, radix: 16))
        #expect(token.hex == hex)
    }

    @Test func launchScreenMatchesTheSplashBackground() throws {
        let launch = try #require(UIColor(named: "LaunchBackground", in: .main, compatibleWith: nil))
        #expect(rgb(launch) == rgb(UIColor(Color.bgApp)))
    }

    @Test func wordmarkFontIsBundled() {
        #expect(UIFont(name: "BebasNeue-Regular", size: 40) != nil)
    }

    private func rgb(_ color: UIColor) -> [Int] {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        color.getRed(&r, green: &g, blue: &b, alpha: &a)
        return [r, g, b, a].map { Int(($0 * 255).rounded()) }
    }
}
