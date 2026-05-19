import SwiftUI

enum FMFont {
    // Display: condensed uppercase (Bebas Neue → fallback to system rounded heavy)
    static func display(_ size: CGFloat) -> Font {
        Font.system(size: size, weight: .heavy, design: .default)
            .width(.condensed)
    }

    // UI body (Space Grotesk → fallback to system rounded)
    static func ui(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        Font.system(size: size, weight: weight, design: .rounded)
    }

    static func mono(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        Font.system(size: size, weight: weight, design: .monospaced)
    }

    // Type scale
    static let xs: CGFloat = 11
    static let sm: CGFloat = 13
    static let base: CGFloat = 15
    static let md: CGFloat = 17
    static let lg: CGFloat = 20
    static let xl: CGFloat = 24
    static let xl2: CGFloat = 32
    static let xl3: CGFloat = 44
    static let xl4: CGFloat = 60
}

enum FMSpace {
    static let s1: CGFloat = 4
    static let s2: CGFloat = 8
    static let s3: CGFloat = 12
    static let s4: CGFloat = 16
    static let s5: CGFloat = 20
    static let s6: CGFloat = 24
    static let s8: CGFloat = 32
    static let s10: CGFloat = 40
    static let s12: CGFloat = 48
    static let s16: CGFloat = 64
    static let s20: CGFloat = 80
}

enum FMRadius {
    static let xs: CGFloat = 4
    static let sm: CGFloat = 6
    static let md: CGFloat = 10
    static let lg: CGFloat = 14
    static let xl: CGFloat = 20
    static let pill: CGFloat = 999
}
