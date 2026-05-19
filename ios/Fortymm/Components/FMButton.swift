import SwiftUI

enum FMButtonVariant {
    case primary    // hero orange filled
    case secondary  // raised dark surface
    case outline    // bordered
    case ghost      // no chrome
    case destructive
    case link
    case disabled
}

enum FMButtonSize {
    case sm, md, lg, icon

    var height: CGFloat {
        switch self {
        case .sm: return 32
        case .md: return 40
        case .lg: return 48
        case .icon: return 40
        }
    }

    var hPadding: CGFloat {
        switch self {
        case .sm: return 12
        case .md: return 16
        case .lg: return 24
        case .icon: return 0
        }
    }

    var iconWidth: CGFloat? {
        self == .icon ? 40 : nil
    }

    var fontSize: CGFloat {
        switch self {
        case .sm: return 13
        case .md: return 14
        case .lg: return 16
        case .icon: return 14
        }
    }
}

struct FMButton: View {
    let title: String
    var variant: FMButtonVariant = .primary
    var size: FMButtonSize = .md
    var action: () -> Void = {}

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(FMFont.ui(size.fontSize, weight: .semibold))
                .foregroundStyle(foreground)
                .frame(maxWidth: size == .icon ? size.iconWidth : nil)
                .frame(height: size.height)
                .padding(.horizontal, size.hPadding)
                .background(background)
                .fmRoundedBorder(radius: FMRadius.md, color: borderColor)
        }
        .buttonStyle(.plain)
        .disabled(variant == .disabled)
    }

    private var foreground: Color {
        switch variant {
        case .primary, .destructive: return FMColor.fgInverse
        case .secondary, .outline, .ghost: return FMColor.fg1
        case .link: return FMColor.fgAccent
        case .disabled: return FMColor.fgMuted
        }
    }

    @ViewBuilder
    private var background: some View {
        switch variant {
        case .primary: FMColor.bgAccent
        case .secondary: FMColor.bgRaised
        case .outline, .ghost, .link: Color.clear
        case .destructive: FMColor.loss
        case .disabled: FMColor.bgCard
        }
    }

    private var borderColor: Color {
        switch variant {
        case .outline: FMColor.borderDefault
        case .disabled: FMColor.borderSubtle
        default: .clear
        }
    }
}
