import SwiftUI

/// The glossy ball-orange disc on its own — the brand mark used in the iOS
/// top bar where the full wordmark would be too wide. Shared by `FMLogo`.
struct FMBall: View {
    var size: CGFloat = 24

    var body: some View {
        Circle()
            .fill(
                RadialGradient(
                    colors: [Color(hex: 0xFFB57A), FMColor.ball500, FMColor.ball700],
                    center: UnitPoint(x: 0.35, y: 0.35),
                    startRadius: 0,
                    endRadius: size * 0.9
                )
            )
            .frame(width: size, height: size)
            .overlay(alignment: .topLeading) {
                Ellipse()
                    .fill(Color.white.opacity(0.22))
                    .frame(width: size * 0.4, height: size * 0.24)
                    .offset(x: size * 0.18, y: size * 0.18)
            }
    }
}

/// The FortyMM wordmark: a glossy ball-orange disc followed by the
/// condensed-display "FORTYMM" wordmark with an accent period.
struct FMLogo: View {
    var size: CGFloat = 26

    var body: some View {
        HStack(spacing: size * 0.36) {
            FMBall(size: size)

            HStack(spacing: 0) {
                Text("FORTYMM")
                    .foregroundStyle(FMColor.fg1)
                Text(".")
                    .foregroundStyle(FMColor.ball500)
            }
            .font(FMFont.display(size * 0.95))
            .tracking(1.5)
        }
    }
}

/// Small uppercase section label with a leading ball-orange dot —
/// the recurring "eyebrow" used above every landing section heading.
struct FMEyebrow: View {
    let text: String

    var body: some View {
        HStack(spacing: FMSpace.s2) {
            Circle()
                .fill(FMColor.ball500)
                .frame(width: 6, height: 6)
            Text(text.uppercased())
                .font(FMFont.mono(FMFont.xs, weight: .medium))
                .tracking(1.5)
                .foregroundStyle(FMColor.fg3)
        }
    }
}

#Preview {
    VStack(alignment: .leading, spacing: 24) {
        FMLogo(size: 26)
        FMLogo(size: 40)
        FMEyebrow(text: "No ads · No tracking · No subscriptions")
    }
    .padding()
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(FMColor.bgApp)
    .preferredColorScheme(.dark)
}
