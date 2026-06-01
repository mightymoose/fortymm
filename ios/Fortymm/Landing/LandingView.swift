import Combine
import SwiftUI

/// Marketing landing page for the FortyMM iOS app, mirroring the web
/// reference at uat.fortymm.com. Built entirely from design-system
/// components and tokens. Every call-to-action is intentionally inert
/// for now — buttons render but don't navigate anywhere yet.
struct LandingView: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: FMSpace.s16) {
                LandingNav()
                LandingHero()
                LandingFeatures()
                LandingTournaments()
                LandingManifesto()
                LandingFAQ()
                LandingCTA()
                LandingFooter()
            }
            .padding(.vertical, FMSpace.s6)
        }
        .background(FMColor.bgApp.ignoresSafeArea())
    }
}

// MARK: - Shared section heading

/// Eyebrow + two-line display headline, the recurring section header
/// used throughout the landing page.
struct LandingSectionHeading: View {
    let eyebrow: String
    let line1: String
    let line2: String
    var line2Color: Color = FMColor.fg3

    var body: some View {
        VStack(alignment: .leading, spacing: FMSpace.s3) {
            FMEyebrow(text: eyebrow)
            VStack(alignment: .leading, spacing: 0) {
                Text(line1)
                    .foregroundStyle(FMColor.fg1)
                Text(line2)
                    .foregroundStyle(line2Color)
            }
            .font(FMFont.display(34))
            .tracking(0.5)
            .lineSpacing(2)
        }
    }
}

// MARK: - Nav

private struct LandingNav: View {
    var body: some View {
        HStack(spacing: FMSpace.s3) {
            FMLogo(size: 24)
            Spacer(minLength: 0)
            FMButton(title: "Sign in", variant: .ghost, size: .sm)
            FMButton(title: "Start playing", variant: .primary, size: .sm)
        }
        .padding(.horizontal, FMSpace.s5)
    }
}

// MARK: - Hero

private struct LandingHero: View {
    var body: some View {
        VStack(alignment: .leading, spacing: FMSpace.s6) {
            FMEyebrow(text: "No ads · No tracking · No subscriptions, ever")

            VStack(alignment: .leading, spacing: 0) {
                Text("Play more.")
                    .foregroundStyle(FMColor.fg1)
                Text("Pay never.")
                    .foregroundStyle(FMColor.ball500)
            }
            .font(FMFont.display(60))
            .lineSpacing(-4)

            Text("FortyMM is a table-tennis match tracker and tournament platform — made by players, for players. No download, no sign-up. When you want a real account, just add an email.")
                .font(FMFont.ui(FMFont.md))
                .foregroundStyle(FMColor.fg3)
                .lineSpacing(3)

            VStack(spacing: FMSpace.s3) {
                FMButton(title: "Start a match", variant: .primary, size: .lg)
                    .frame(maxWidth: .infinity)
                FMButton(title: "Run a tournament", variant: .secondary, size: .lg)
                    .frame(maxWidth: .infinity)
            }

            HStack(spacing: FMSpace.s4) {
                heroMeta(icon: "iphone", text: "Web. iOS & Android soon.")
                Rectangle().fill(FMColor.borderSubtle).frame(width: 1, height: 14)
                heroMeta(icon: "star", text: "Open source. GPLv3.")
            }
            .padding(.top, FMSpace.s1)

            LandingScoreboard()
                .padding(.top, FMSpace.s4)

            LandingStatsStrip()
        }
        .padding(.horizontal, FMSpace.s5)
    }

    private func heroMeta(icon: String, text: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 12))
                .foregroundStyle(FMColor.fgMuted)
            Text(text)
                .font(FMFont.ui(FMFont.xs))
                .foregroundStyle(FMColor.fgMuted)
        }
    }
}

// MARK: - Stats strip

private struct LandingStatsStrip: View {
    private let stats: [(n: String, l: String, accent: Bool)] = [
        ("12,480", "matches logged", false),
        ("340", "clubs worldwide", false),
        ("1,102", "tournaments run", false),
        ("0", "dollars charged", true),
    ]

    private let columns = [GridItem(.flexible(), spacing: FMSpace.s4),
                           GridItem(.flexible(), spacing: FMSpace.s4)]

    var body: some View {
        FMCard {
            LazyVGrid(columns: columns, alignment: .leading, spacing: FMSpace.s4) {
                ForEach(Array(stats.enumerated()), id: \.offset) { _, s in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(s.n)
                            .font(FMFont.display(30))
                            .foregroundStyle(s.accent ? FMColor.ball500 : FMColor.fg1)
                            .lineLimit(1)
                            .minimumScaleFactor(0.7)
                        Text(s.l.uppercased())
                            .font(FMFont.mono(9))
                            .tracking(0.8)
                            .foregroundStyle(FMColor.fgMuted)
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }
}

// MARK: - Animated live scoreboard

private struct LandingScoreboard: View {
    @State private var tick = 0
    private let timer = Timer.publish(every: 2.6, on: .main, in: .common).autoconnect()

    private let seq: [(Int, Int)] = [
        (8, 8), (9, 8), (9, 9), (10, 9), (10, 10), (11, 10), (11, 11), (12, 11),
    ]

    private var score: (a: Int, b: Int) { seq[tick % seq.count] }
    private var aServing: Bool { tick % 4 < 2 }

    var body: some View {
        FMCard {
            VStack(spacing: FMSpace.s3) {
                HStack {
                    FMBadge(text: "Live · Game 4 · BO5", variant: .live)
                    Spacer()
                    Text("COURT 3 · 19:42")
                        .font(FMFont.mono(FMFont.xs))
                        .foregroundStyle(FMColor.fgMuted)
                }

                player(name: "Nguyen, T.", initials: "NG", seed: "1", rating: "2145",
                       score: score.a, winning: score.a > score.b, serving: aServing)
                Rectangle().fill(FMColor.borderSubtle).frame(height: 1)
                player(name: "Okafor, D.", initials: "OK", seed: "8", rating: "1988",
                       score: score.b, winning: score.b > score.a, serving: !aServing)

                HStack(spacing: 6) {
                    gameBox((11, 6), label: "G1", live: false)
                    gameBox((9, 11), label: "G2", live: false)
                    gameBox((11, 8), label: "G3", live: false)
                    gameBox(score, label: "G4", live: true)
                }
                .padding(.top, 2)

                HStack {
                    Text("Sets 2–1")
                        .font(FMFont.ui(FMFont.xs))
                        .foregroundStyle(FMColor.fg3)
                    Spacer()
                    Text("Next: ")
                        .font(FMFont.ui(FMFont.xs))
                        .foregroundStyle(FMColor.fgMuted)
                        + Text("+8 rating")
                        .font(FMFont.mono(FMFont.xs))
                        .foregroundColor(FMColor.fgAccent)
                }
            }
        }
        .onReceive(timer) { _ in
            withAnimation(.easeInOut(duration: 0.3)) { tick += 1 }
        }
    }

    private func player(name: String, initials: String, seed: String, rating: String,
                        score: Int, winning: Bool, serving: Bool) -> some View {
        HStack(spacing: FMSpace.s3) {
            FMAvatar(initials: initials, size: 36,
                     color: winning ? FMColor.ball500 : FMColor.ink600,
                     foreground: winning ? FMColor.fgInverse : FMColor.fg2)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(name)
                        .font(FMFont.ui(FMFont.md, weight: .semibold))
                        .foregroundStyle(FMColor.fg1)
                    if serving {
                        Circle().fill(FMColor.ball500).frame(width: 6, height: 6)
                    }
                }
                Text("SEED \(seed) · \(rating)")
                    .font(FMFont.mono(FMFont.xs))
                    .foregroundStyle(FMColor.fgMuted)
            }
            Spacer()
            Text(String(format: "%02d", score))
                .font(FMFont.display(40))
                .foregroundStyle(winning ? FMColor.ball500 : FMColor.fg1)
                .contentTransition(.numericText())
                .monospacedDigit()
        }
    }

    private func gameBox(_ g: (Int, Int), label: String, live: Bool) -> some View {
        VStack(spacing: 2) {
            Text(label)
                .font(FMFont.mono(9))
                .foregroundStyle(FMColor.fgMuted)
            Text("\(g.0)")
                .font(FMFont.mono(FMFont.sm, weight: .semibold))
                .foregroundStyle(g.0 > g.1 ? FMColor.win : FMColor.fg3)
            Rectangle().fill(FMColor.borderSubtle).frame(height: 1).frame(width: 16)
            Text("\(g.1)")
                .font(FMFont.mono(FMFont.sm, weight: .semibold))
                .foregroundStyle(g.1 > g.0 ? FMColor.win : FMColor.fg3)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
        .background(live ? FMColor.bgAccentSoft : FMColor.bgRaised)
        .fmRoundedBorder(radius: FMRadius.sm,
                         color: live ? FMColor.borderAccent : FMColor.borderSubtle)
    }
}

#Preview {
    LandingView().preferredColorScheme(.dark)
}
