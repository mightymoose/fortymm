import SwiftUI

/// Compact, centered top bar: the brand ball on the left, an absolutely-centered
/// title, and a translucent dark surface with a hairline bottom border. Laid
/// over the top safe area via `.safeAreaInset` so content scrolls under it.
struct FMTopBar: View {
    /// Height of the bar itself.
    static let barHeight: CGFloat = 46
    /// Top padding a tab's scroll content needs to clear the bar. The bar is laid
    /// over the top via the shell's `.safeAreaInset`, and that inset doesn't fully
    /// reduce the scroll content's safe area inside the `TabView` — so content
    /// renders under the bar unless each tab screen pads by the bar height plus a
    /// small gap. Use this constant rather than hardcoding the value per screen.
    static let contentInset: CGFloat = barHeight + 10

    let title: String

    var body: some View {
        ZStack {
            HStack {
                FMBall(size: 24)
                Spacer()
            }
            Text(title)
                .font(FMFont.ui(FMFont.md, weight: .bold))
                .foregroundStyle(FMColor.fg1)
        }
        .padding(.horizontal, 14)
        .frame(height: Self.barHeight)
        .frame(maxWidth: .infinity)
        .background(alignment: .bottom) { barBackground }
    }

    private var barBackground: some View {
        ZStack {
            Rectangle().fill(.ultraThinMaterial)
            Rectangle().fill(FMColor.ink950.opacity(0.7))
        }
        .overlay(alignment: .bottom) {
            Rectangle().fill(FMColor.borderSubtle).frame(height: 1)
        }
        .ignoresSafeArea(edges: .top)
    }
}

#Preview {
    ZStack {
        FMColor.bgApp.ignoresSafeArea()
        VStack(spacing: 0) {
            FMTopBar(title: "FortyMM")
            Spacer()
        }
    }
    .preferredColorScheme(.dark)
}
