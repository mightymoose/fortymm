import SwiftUI

enum FMAlertVariant {
    case info, warn, destructive, success
}

private struct FMAlertStyle {
    let icon: String
    let tint: Color
    let background: Color
    let border: Color
    let titleColor: Color
}

private extension FMAlertVariant {
    var style: FMAlertStyle {
        switch self {
        case .info:
            return FMAlertStyle(icon: "info.circle", tint: FMColor.info,
                                background: FMColor.bgCard, border: FMColor.borderSubtle,
                                titleColor: FMColor.fg1)
        case .warn:
            return FMAlertStyle(icon: "exclamationmark.triangle", tint: FMColor.warn,
                                background: FMColor.warn.opacity(0.08), border: FMColor.warn.opacity(0.4),
                                titleColor: FMColor.warn)
        case .destructive:
            return FMAlertStyle(icon: "xmark.circle", tint: FMColor.loss,
                                background: FMColor.loss.opacity(0.08), border: FMColor.loss.opacity(0.4),
                                titleColor: FMColor.loss)
        case .success:
            return FMAlertStyle(icon: "checkmark.circle", tint: FMColor.win,
                                background: FMColor.win.opacity(0.08), border: FMColor.win.opacity(0.4),
                                titleColor: FMColor.win)
        }
    }
}

struct FMAlert: View {
    let title: String
    let message: String
    var variant: FMAlertVariant = .info

    var body: some View {
        let s = variant.style
        return HStack(alignment: .top, spacing: 12) {
            Image(systemName: s.icon)
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(s.tint)
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(FMFont.ui(FMFont.sm, weight: .semibold))
                    .foregroundStyle(s.titleColor)
                Text(message)
                    .font(FMFont.ui(FMFont.sm))
                    .foregroundStyle(FMColor.fg3)
            }
            Spacer(minLength: 0)
        }
        .padding(FMSpace.s4)
        .background(s.background)
        .fmRoundedBorder(radius: FMRadius.md, color: s.border)
    }
}

enum FMToastVariant { case info, success, destructive, reminder }

struct FMToast: View {
    let title: String
    let message: String
    var variant: FMToastVariant = .info
    var actionTitle: String? = nil

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Capsule()
                .fill(accent)
                .frame(width: 3)
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .top) {
                    Text(title)
                        .font(FMFont.ui(FMFont.sm, weight: .semibold))
                        .foregroundStyle(FMColor.fg1)
                    Spacer()
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(FMColor.fgMuted)
                }
                Text(message)
                    .font(FMFont.ui(FMFont.xs))
                    .foregroundStyle(FMColor.fg3)
                if let actionTitle {
                    HStack {
                        Spacer()
                        Text(actionTitle)
                            .font(FMFont.ui(FMFont.xs, weight: .semibold))
                            .foregroundStyle(FMColor.fgInverse)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .background(FMColor.chalk50)
                            .clipShape(Capsule())
                    }
                }
            }
            .padding(.vertical, 10)
            .padding(.trailing, 12)
        }
        .background(FMColor.bgCard)
        .fmRoundedBorder(radius: FMRadius.md, color: FMColor.borderSubtle)
    }

    private var accent: Color {
        switch variant {
        case .info, .reminder: return FMColor.info
        case .success: return FMColor.win
        case .destructive: return FMColor.loss
        }
    }
}
