import SwiftUI

extension Color {
    init(hex: UInt32, opacity: Double = 1.0) {
        let r = Double((hex >> 16) & 0xFF) / 255.0
        let g = Double((hex >> 8) & 0xFF) / 255.0
        let b = Double(hex & 0xFF) / 255.0
        self.init(.sRGB, red: r, green: g, blue: b, opacity: opacity)
    }
}

enum FMColor {
    // Ink (dark surfaces)
    static let ink950 = Color(hex: 0x0B0D12)
    static let ink900 = Color(hex: 0x11141B)
    static let ink800 = Color(hex: 0x171B24)
    static let ink700 = Color(hex: 0x1F2430)
    static let ink600 = Color(hex: 0x2A3040)
    static let ink500 = Color(hex: 0x3A4152)
    static let ink400 = Color(hex: 0x535B6E)

    // Chalk (foreground)
    static let chalk50 = Color(hex: 0xF7F8FB)
    static let chalk100 = Color(hex: 0xE4E7EF)
    static let chalk300 = Color(hex: 0xA9B0C2)
    static let chalk500 = Color(hex: 0x6B7283)

    // Ball (brand orange)
    static let ball50 = Color(hex: 0xFFF4ED)
    static let ball200 = Color(hex: 0xFFCFA8)
    static let ball400 = Color(hex: 0xFF9A4A)
    static let ball500 = Color(hex: 0xFF7A1A)
    static let ball600 = Color(hex: 0xE85E00)
    static let ball700 = Color(hex: 0xB94700)

    // Serve (live/win green)
    static let serve300 = Color(hex: 0x8CFFD4)
    static let serve500 = Color(hex: 0x00E29A)
    static let serve700 = Color(hex: 0x009968)

    // Semantic
    static let win = Color(hex: 0x00E29A)
    static let loss = Color(hex: 0xFF4D6D)
    static let warn = Color(hex: 0xFFC43D)
    static let info = Color(hex: 0x6FB5FF)

    // Foreground roles
    static let fg1 = chalk50
    static let fg2 = chalk100
    static let fg3 = chalk300
    static let fgMuted = chalk500
    static let fgDisabled = ink400
    static let fgAccent = ball500
    static let fgAccentHover = ball400
    static let fgLive = serve500
    static let fgInverse = ink950

    // Background roles
    static let bgApp = ink950
    static let bgPanel = ink900
    static let bgCard = ink800
    static let bgRaised = ink700
    static let bgHover = Color.white.opacity(0.04)
    static let bgPress = Color.white.opacity(0.02)
    static let bgAccent = ball500
    static let bgAccentHover = ball400
    static let bgAccentSoft = ball500.opacity(0.12)
    static let bgLiveSoft = serve500.opacity(0.14)

    // Borders
    static let borderSubtle = ink600
    static let borderDefault = ink500
    static let borderStrong = chalk500
    static let borderAccent = ball500
}
