import SwiftUI

/// Compact, centered top bar: the brand ball on the left, an absolutely-centered
/// title, an amber "Alpha" pill on the right, and a translucent dark surface with
/// a hairline bottom border. Laid over the top safe area via `.safeAreaInset` so
/// content scrolls under it.
struct FMTopBar: View {
    /// Height of the bar itself.
    static let barHeight: CGFloat = 46

    let title: String

    @State private var showingAlphaInfo = false

    var body: some View {
        ZStack {
            HStack {
                FMBall(size: 24)
                Spacer()
                alphaBadge
            }
            Text(title)
                .font(FMFont.ui(FMFont.md, weight: .bold))
                .foregroundStyle(FMColor.fg1)
        }
        .padding(.horizontal, 14)
        .frame(height: Self.barHeight)
        .frame(maxWidth: .infinity)
        .background(alignment: .bottom) { barBackground }
        .sheet(isPresented: $showingAlphaInfo) {
            AlphaInfoSheet()
                .presentationDetents([.medium])
                .presentationDragIndicator(.visible)
        }
    }

    /// Amber pill mirroring the web app's "Alpha" badge — taps open a disclaimer sheet.
    private var alphaBadge: some View {
        Button {
            showingAlphaInfo = true
        } label: {
            HStack(spacing: 5) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 9, weight: .bold))
                Text("Alpha")
                    .font(FMFont.ui(FMFont.xs, weight: .semibold))
                    .textCase(.uppercase)
                    .tracking(0.8)
                Image(systemName: "chevron.down")
                    .font(.system(size: 8, weight: .bold))
                    .opacity(0.6)
            }
            .foregroundStyle(FMColor.warn)
            .padding(.horizontal, 9)
            .padding(.vertical, 4)
            .background(FMColor.warn.opacity(0.15))
            .overlay(Capsule().stroke(FMColor.warn.opacity(0.5), lineWidth: 1))
            .clipShape(Capsule())
        }
        .accessibilityLabel("About the alpha release")
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

/// Disclaimer shown when the user taps the "Alpha" pill — mirrors the web popover copy.
private struct AlphaInfoSheet: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top, spacing: 12) {
                ZStack {
                    Circle().fill(FMColor.warn.opacity(0.2))
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(FMColor.warn)
                }
                .frame(width: 36, height: 36)

                VStack(alignment: .leading, spacing: 3) {
                    Text("You're using an early alpha")
                        .font(FMFont.ui(FMFont.md, weight: .bold))
                        .foregroundStyle(FMColor.fg1)
                    Text("FortyMM is under active development — expect rough edges.")
                        .font(FMFont.ui(FMFont.sm))
                        .foregroundStyle(FMColor.fg3)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            VStack(alignment: .leading, spacing: 8) {
                bullet("Features may change or break without warning.")
                bullet("Your data can be reset or lost at any time.")
                bullet("Please don't rely on it for anything important yet.")
            }

            Text("Thanks for helping us test it. 🏓")
                .font(FMFont.ui(FMFont.sm))
                .foregroundStyle(FMColor.fg2)

            Spacer(minLength: 0)
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(FMColor.bgApp.ignoresSafeArea())
    }

    private func bullet(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text("•")
                .font(FMFont.ui(FMFont.sm))
                .foregroundStyle(FMColor.fgMuted)
            Text(text)
                .font(FMFont.ui(FMFont.sm))
                .foregroundStyle(FMColor.fgMuted)
                .fixedSize(horizontal: false, vertical: true)
        }
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
