import SwiftUI

/// The design system's colour tokens that the app uses, from
/// `references/design-system/colors_and_type.css`. The raw value is the CSS
/// variable's name without `--`.
enum DesignToken: String, CaseIterable {
    case ink950 = "ink-950"
    case ink900 = "ink-900"
    case ink800 = "ink-800"
    case ink700 = "ink-700"
    case ink600 = "ink-600"
    case ink500 = "ink-500"
    case chalk50 = "chalk-50"
    case chalk100 = "chalk-100"
    case chalk300 = "chalk-300"
    case ball500 = "ball-500"
    case ball600 = "ball-600"
    case green400 = "green-400"
    case blue300 = "blue-300"
    case danger
    case borderField = "border-field"

    var hex: UInt32 {
        switch self {
        case .ink950: 0x0B0D12
        case .ink900: 0x11141B
        case .ink800: 0x171B24
        case .ink700: 0x1F2430
        case .ink600: 0x2A3040
        case .ink500: 0x3A4152
        case .chalk50: 0xF7F8FB
        case .chalk100: 0xE4E7EF
        case .chalk300: 0xA9B0C2
        case .ball500: 0xFF7A1A
        case .ball600: 0xE85E00
        case .green400: 0x3DD68C
        case .blue300: 0x7AB8FF
        case .danger: 0xFF6B6B
        case .borderField: 0x6B7389
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

/// The design system's semantic colours, by their CSS names.
extension Color {
    static let bgApp = DesignToken.ink950.color
    static let bgPanel = DesignToken.ink900.color
    static let bgGroup = DesignToken.ink800.color
    static let bgHover = DesignToken.ink700.color
    static let fg1 = DesignToken.chalk50.color
    static let fg2 = DesignToken.chalk100.color
    static let fg3 = DesignToken.chalk300.color
    static let accent = DesignToken.ball500.color
    static let accentPress = DesignToken.ball600.color
    static let onAccent = DesignToken.ink950.color
    static let rest = DesignToken.blue300.color
    static let restSoft = DesignToken.blue300.color.opacity(0.10)
    static let success = DesignToken.green400.color
    static let danger = DesignToken.danger.color
    static let dangerSoft = DesignToken.danger.color.opacity(0.10)
    static let borderSubtle = DesignToken.ink600.color
    static let borderControl = DesignToken.ink500.color
    static let borderField = DesignToken.borderField.color
}

extension Font {
    /// Bebas Neue, the design system's `--font-display`. Only the wordmark
    /// uses it.
    static func display(size: CGFloat) -> Font {
        .custom("BebasNeue-Regular", fixedSize: size)
    }

    /// JetBrains Mono, the design system's `--font-num`, for numbers that
    /// line up. It grows with Dynamic Type, as the text around it does.
    static func number(size: CGFloat, relativeTo style: TextStyle) -> Font {
        .custom("JetBrainsMono-Regular", size: size, relativeTo: style)
    }
}
