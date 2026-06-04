import SwiftUI

/// Compact, centered top bar: the brand ball on the left, an absolutely-centered
/// title, and a translucent dark surface with a hairline bottom border. Laid
/// over the top safe area via `.safeAreaInset` so content scrolls under it.
struct FMTopBar: View {
    /// Height of the bar itself.
    static let barHeight: CGFloat = 46

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

extension View {
    /// Lay the shell's frosted top bar over this screen, reserving safe area for it
    /// (bar height plus a small gap) so the screen's own `ScrollView` automatically
    /// insets its content below the bar — no per-screen top padding required.
    ///
    /// Attach this to each tab *screen*, not to the `TabView`: a `.safeAreaInset`
    /// on a `TabView` doesn't propagate the inset into the per-tab scroll views, so
    /// their content renders under the bar.
    func fmTopBar(_ title: String) -> some View {
        safeAreaInset(edge: .top, spacing: 10) { FMTopBar(title: title) }
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
