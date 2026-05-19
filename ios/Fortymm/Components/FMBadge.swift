import SwiftUI

enum FMBadgeVariant {
    case primary   // orange filled (e.g. "Seed 1")
    case secondary // dark filled (e.g. "Doubles")
    case outline   // outlined (e.g. "Pending")
    case destructive // soft rose (e.g. "Disqualified")
    case live      // green soft-glow (e.g. "Live · Court 3")
}

struct FMBadge: View {
    let text: String
    var variant: FMBadgeVariant = .primary
    var icon: String? = nil

    var body: some View {
        HStack(spacing: 4) {
            if variant == .live {
                Circle()
                    .fill(FMColor.serve500)
                    .frame(width: 6, height: 6)
            }
            if let icon {
                Image(systemName: icon)
                    .font(.system(size: 10, weight: .bold))
            }
            Text(text)
                .font(FMFont.ui(FMFont.xs, weight: .semibold))
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .foregroundStyle(foreground)
        .background(background)
        .overlay(border)
        .clipShape(Capsule())
        .shadow(color: variant == .live ? FMColor.serve500.opacity(0.4) : .clear, radius: 8)
    }

    private var foreground: Color {
        switch variant {
        case .primary: return FMColor.fgInverse
        case .secondary, .outline: return FMColor.fg2
        case .destructive: return FMColor.loss
        case .live: return FMColor.serve500
        }
    }

    @ViewBuilder
    private var background: some View {
        switch variant {
        case .primary: FMColor.ball500
        case .secondary: FMColor.bgRaised
        case .outline: Color.clear
        case .destructive: FMColor.loss.opacity(0.18)
        case .live: FMColor.bgLiveSoft
        }
    }

    @ViewBuilder
    private var border: some View {
        switch variant {
        case .outline:
            Capsule().stroke(FMColor.borderDefault, lineWidth: 1)
        case .live:
            Capsule().stroke(FMColor.serve500.opacity(0.4), lineWidth: 1)
        case .destructive:
            Capsule().stroke(FMColor.loss.opacity(0.3), lineWidth: 1)
        default:
            EmptyView()
        }
    }
}
