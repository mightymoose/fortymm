import SwiftUI

/// The design system's colour tokens that the app uses, from
/// `references/design-system/colors_and_type.css`. The raw value is the CSS
/// variable's name without `--`.
enum DesignToken: String, CaseIterable {
    case ink950 = "ink-950"
    case chalk50 = "chalk-50"

    var hex: UInt32 {
        switch self {
        case .ink950: 0x0B0D12
        case .chalk50: 0xF7F8FB
        }
    }

    var color: Color {
        Color(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
    }
}

extension Color {
    static let bgApp = DesignToken.ink950.color
    static let fg1 = DesignToken.chalk50.color
}

extension Font {
    /// Bebas Neue, the design system's `--font-display`. Only the wordmark
    /// uses it.
    static func display(size: CGFloat) -> Font {
        .custom("BebasNeue-Regular", fixedSize: size)
    }
}
