import SwiftUI

/// Screen 3 — posted match detail / Final summary. Plays a brief win
/// celebration (score scales in with a ball-bounce, plus a ball-dot burst),
/// suppressed under Reduce Motion.
struct MatchDetailView: View {
    let match: FinalMatch
    var onBack: () -> Void
    var onAgain: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var reveal = false

    private var need: Int { MatchRules.gamesToWin(bestOf: match.bestOf) }

    var body: some View {
        ZStack(alignment: .bottom) {
            FMColor.ink950.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    breadcrumb
                    hero
                    gamesSection
                    if match.rated, let delta = match.ratingDelta { ratingSection(delta) }
                    infoSection
                    if !match.solo { headToHeadSection }
                }
                .padding(.bottom, 120)
            }
            footer
        }
        .onAppear {
            if reduceMotion { reveal = true }
            else { withAnimation(.spring(response: 0.42, dampingFraction: 0.5).delay(0.06)) { reveal = true } }
        }
    }

    // MARK: Breadcrumb

    private var breadcrumb: some View {
        HStack(spacing: 6) {
            Button(action: onBack) {
                Image(systemName: "arrow.left")
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(FMColor.fg3)
                    .frame(width: 40, height: 40)
            }
            .buttonStyle(.plain)
            (Text("MATCHES ").foregroundStyle(FMColor.fgMuted)
                + Text("›  ").foregroundStyle(FMColor.ink500)
                + Text("MATCH \(match.id)").foregroundStyle(FMColor.fg3))
                .font(FMFont.ui(11, weight: .semibold))
                .tracking(1.2)
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 6)
    }

    // MARK: Hero

    private var hero: some View {
        VStack(spacing: 20) {
            HStack {
                HStack(spacing: 7) {
                    Circle().fill(FMColor.ball500).frame(width: 7, height: 7)
                        .shadow(color: FMColor.ball500.opacity(0.55), radius: 5)
                    Text("FINAL").font(FMFont.ui(11, weight: .semibold)).tracking(1.0)
                }
                .foregroundStyle(FMColor.ball500)
                .padding(.horizontal, 11)
                .padding(.vertical, 5)
                .background(FMColor.bgAccentSoft)
                .overlay(Capsule().stroke(FMColor.ball500.opacity(0.4), lineWidth: 1))
                .clipShape(Capsule())
                Spacer()
                Text("SINGLES · BO\(match.bestOf) · FIRST TO \(need)")
                    .font(FMFont.ui(10, weight: .semibold))
                    .tracking(1.0)
                    .foregroundStyle(FMColor.fgMuted)
            }

            HStack(spacing: 8) {
                playerColumn(match.you, name: match.you.handle, winnerSide: match.win)
                VStack(spacing: 6) {
                    HStack(spacing: 10) {
                        Text("\(match.setsWon.a)")
                            .foregroundStyle(match.win ? FMColor.serve500 : FMColor.fg2)
                        Text("-").font(FMFont.mono(30)).foregroundStyle(FMColor.fgMuted)
                        Text("\(match.setsWon.b)")
                            .foregroundStyle(!match.win ? FMColor.serve500 : FMColor.fg2)
                    }
                    .font(FMFont.mono(60, weight: .bold))
                    .scaleEffect(reveal ? 1 : 0.7)
                    .opacity(reveal ? 1 : 0)
                    Text("FINAL")
                        .font(FMFont.ui(11, weight: .medium))
                        .tracking(1.4)
                        .foregroundStyle(FMColor.fgMuted)
                }
                .frame(maxWidth: .infinity)
                playerColumn(match.opponent, name: match.opponent.handle, winnerSide: !match.win && !match.solo)
            }
        }
        .padding(.horizontal, 18)
        .padding(.top, 18)
        .padding(.bottom, 22)
        .background(FMColor.ink900)
        .fmRoundedBorder(radius: 18, color: FMColor.borderSubtle)
        .overlay { if reveal && !reduceMotion { BurstView().allowsHitTesting(false) } }
        .padding(.horizontal, 16)
        .padding(.top, 8)
    }

    private func playerColumn(_ player: MatchPlayer, name: String, winnerSide: Bool) -> some View {
        VStack(spacing: 8) {
            MatchAvatar(player: player, size: 52, glow: winnerSide)
            Text(name)
                .font(FMFont.ui(13, weight: .semibold))
                .foregroundStyle(winnerSide ? FMColor.serve500 : FMColor.fg1)
                .multilineTextAlignment(.center)
        }
        .frame(width: 96)
    }

    // MARK: Games

    private var gamesSection: some View {
        Section_("Games") {
            VStack(spacing: 0) {
                ForEach(Array(match.games.enumerated()), id: \.offset) { i, g in
                    let aw = (g.a ?? 0) > (g.b ?? 0)
                    HStack {
                        Text("GAME \(i + 1)")
                            .font(FMFont.ui(10, weight: .semibold))
                            .tracking(1.2)
                            .foregroundStyle(FMColor.fgMuted)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        HStack(spacing: 14) {
                            Text("\(g.a ?? 0)").foregroundStyle(aw ? FMColor.serve500 : FMColor.fg2)
                                .frame(width: 36, alignment: .trailing)
                            Text("-").font(FMFont.mono(14)).foregroundStyle(FMColor.ink500)
                            Text("\(g.b ?? 0)").foregroundStyle(!aw ? FMColor.serve500 : FMColor.fg2)
                                .frame(width: 36, alignment: .leading)
                        }
                        .font(FMFont.mono(22, weight: .bold))
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 13)
                    if i < match.games.count - 1 { Divider().overlay(FMColor.ink700) }
                }
            }
            .background(FMColor.ink900)
            .fmRoundedBorder(radius: FMRadius.lg, color: FMColor.borderSubtle)
        }
    }

    // MARK: Rating

    private func ratingSection(_ delta: Int) -> some View {
        Section_("Your rating") {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("\(match.you.rating + delta)")
                            .font(FMFont.mono(28, weight: .bold))
                            .foregroundStyle(FMColor.fg1)
                        Text("\(delta >= 0 ? "+" : "")\(delta)")
                            .font(FMFont.mono(15, weight: .bold))
                            .foregroundStyle(delta >= 0 ? FMColor.serve500 : FMColor.loss)
                    }
                    Text("was \(match.you.rating)")
                        .font(FMFont.ui(11, weight: .medium))
                        .foregroundStyle(FMColor.fgMuted)
                }
                Spacer()
                Sparkline(up: delta >= 0, color: delta >= 0 ? FMColor.serve500 : FMColor.loss)
                    .frame(width: 112, height: 30)
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 16)
            .background(FMColor.ink900)
            .fmRoundedBorder(radius: FMRadius.lg, color: FMColor.borderSubtle)
        }
    }

    // MARK: Info

    private var infoSection: some View {
        Section_("Match info") {
            VStack(spacing: 0) {
                InfoRow(key: "Format", value: "Best of \(match.bestOf), first to \(need)")
                InfoRow(key: "Scoring", value: "To 11, win by 2")
                InfoRow(key: "Status", value: "Final", valueColor: FMColor.ball500)
                InfoRow(key: "Rated", value: match.rated ? "Yes" : "No",
                        valueColor: match.rated ? FMColor.serve500 : FMColor.fg3, last: true)
            }
            .padding(.horizontal, 16)
            .background(FMColor.ink900)
            .fmRoundedBorder(radius: FMRadius.lg, color: FMColor.borderSubtle)
        }
    }

    // MARK: Head to head

    private var headToHeadSection: some View {
        let past = MatchSeed.matches.filter { $0.opponent.handle == match.opponent.handle }
        let w = past.filter(\.win).count + (match.win ? 1 : 0)
        let l = past.filter { !$0.win }.count + (match.win ? 0 : 1)
        let total = w + l
        var meetings: [(when: String, res: String, win: Bool)] = [
            (match.when, "\(match.setsWon.a)-\(match.setsWon.b)", match.win)
        ]
        meetings += past.prefix(3).map { ($0.when, "\($0.setsWon.a)-\($0.setsWon.b)", $0.win) }

        return VStack(alignment: .leading, spacing: 11) {
            HStack(alignment: .firstTextBaseline) {
                Eyebrow("Head to head")
                Spacer()
                Text("\(total) MEETINGS")
                    .font(FMFont.ui(10, weight: .medium)).tracking(1.0)
                    .foregroundStyle(FMColor.fgMuted)
            }
            VStack(spacing: 0) {
                HStack(spacing: 14) {
                    Text("\(w)").font(FMFont.mono(26, weight: .bold)).foregroundStyle(FMColor.serve500)
                    Text("you").font(FMFont.ui(11, weight: .medium)).foregroundStyle(FMColor.fgMuted)
                    Text("-").font(FMFont.mono(18)).foregroundStyle(FMColor.ink500)
                    Text("them").font(FMFont.ui(11, weight: .medium)).foregroundStyle(FMColor.fgMuted)
                    Text("\(l)").font(FMFont.mono(26, weight: .bold)).foregroundStyle(FMColor.fg2)
                }
                .padding(.bottom, 12)
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule().fill(FMColor.ink700)
                        Capsule().fill(FMColor.serve500)
                            .frame(width: geo.size.width * (total == 0 ? 0.5 : Double(w) / Double(total)))
                    }
                }
                .frame(height: 7)
                .padding(.bottom, 14)
                ForEach(Array(meetings.enumerated()), id: \.offset) { i, m in
                    HStack {
                        Text(m.when).font(FMFont.ui(12, weight: .medium)).foregroundStyle(FMColor.fg3)
                        Spacer()
                        Text(m.res).font(FMFont.mono(13, weight: .semibold)).foregroundStyle(FMColor.fg2)
                        Text(m.win ? "W" : "L")
                            .font(FMFont.ui(10, weight: .bold))
                            .foregroundStyle(m.win ? FMColor.serve500 : FMColor.loss)
                            .frame(width: 16)
                    }
                    .padding(.vertical, 9)
                    .overlay(alignment: .top) {
                        if i != 0 { Rectangle().fill(FMColor.ink700).frame(height: 1) }
                    }
                }
            }
            .padding(16)
            .background(FMColor.ink900)
            .fmRoundedBorder(radius: FMRadius.lg, color: FMColor.borderSubtle)
        }
        .padding(.horizontal, 16)
        .padding(.top, 20)
    }

    // MARK: Footer

    private var footer: some View {
        HStack(spacing: 10) {
            Button(action: onAgain) {
                Text("Log another")
                    .font(FMFont.ui(15, weight: .semibold))
                    .foregroundStyle(FMColor.fg2)
                    .padding(.horizontal, 22)
                    .frame(height: 50)
                    .fmRoundedBorder(radius: 13, color: FMColor.borderDefault)
            }
            .buttonStyle(.plain)
            Button(action: onBack) {
                Text("Back to matches")
                    .font(FMFont.ui(16, weight: .bold))
                    .foregroundStyle(FMColor.fgInverse)
                    .frame(maxWidth: .infinity)
                    .frame(height: 50)
                    .background(BallGradient())
                    .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
                    .shadow(color: FMColor.ball500.opacity(0.32), radius: 11, y: 8)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 16)
        .padding(.top, 14)
        .padding(.bottom, 30)
        .background(
            LinearGradient(colors: [.clear, FMColor.ink950.opacity(0.96)],
                           startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea()
        )
    }
}

// MARK: - Reusable detail bits

/// Eyebrow-titled detail section (underscore avoids clashing with SwiftUI.Section).
private struct Section_<Content: View>: View {
    let title: String
    @ViewBuilder var content: () -> Content
    init(_ title: String, @ViewBuilder content: @escaping () -> Content) {
        self.title = title; self.content = content
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 11) {
            Eyebrow(title)
            content()
        }
        .padding(.horizontal, 16)
        .padding(.top, 20)
    }
}

private struct InfoRow: View {
    let key: String
    let value: String
    var valueColor: Color = FMColor.fg1
    var last: Bool = false
    var body: some View {
        HStack {
            Text(key).font(FMFont.ui(13, weight: .medium)).foregroundStyle(FMColor.fg3)
            Spacer()
            Text(value).font(FMFont.mono(13, weight: .semibold)).tracking(0.4).foregroundStyle(valueColor)
        }
        .padding(.vertical, 13)
        .overlay(alignment: .bottom) {
            if !last { Rectangle().fill(FMColor.ink700).frame(height: 1) }
        }
    }
}

/// Tiny up/down rating trend line (decorative — fixed shape from the prototype).
private struct Sparkline: View {
    let up: Bool
    let color: Color
    private var points: [CGPoint] {
        let raw: [(CGFloat, CGFloat)] = up
            ? [(0,26),(18,22),(36,24),(54,15),(72,17),(90,8),(108,4)]
            : [(0,6),(18,9),(36,7),(54,14),(72,12),(90,20),(108,26)]
        return raw.map { CGPoint(x: $0.0, y: $0.1) }
    }
    var body: some View {
        ZStack {
            Path { p in
                p.addLines(points)
            }
            .stroke(color, style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
            if let last = points.last {
                Circle().fill(color).frame(width: 6, height: 6).position(last)
            }
        }
        .frame(width: 112, height: 30)
    }
}

/// One-shot celebratory ball-dot burst behind the hero score.
private struct BurstView: View {
    @State private var go = false
    // Deterministic pseudo-random offsets (no Date/random at view-build time).
    private let dots: [(x: CGFloat, dx: CGFloat, size: CGFloat, serve: Bool, dur: Double)] = (0..<12).map { i in
        let f = Double(i) / 12
        return (
            x: CGFloat(0.5 + sin(Double(i) * 1.7) * 0.32),
            dx: CGFloat(cos(Double(i) * 2.3) * 60),
            size: CGFloat(5 + (Double(i % 4)) * 1.6),
            serve: i % 2 == 0,
            dur: 0.9 + f * 0.7
        )
    }
    var body: some View {
        GeometryReader { geo in
            ZStack {
                ForEach(0..<dots.count, id: \.self) { i in
                    let d = dots[i]
                    Circle()
                        .fill(d.serve ? FMColor.serve500 : FMColor.ball500)
                        .frame(width: d.size, height: d.size)
                        .shadow(color: (d.serve ? FMColor.serve500 : FMColor.ball500).opacity(0.7), radius: 4)
                        .position(x: geo.size.width * d.x, y: geo.size.height * 0.62)
                        .offset(x: go ? d.dx : 0, y: go ? -90 : 0)
                        .opacity(go ? 0 : 1)
                        .animation(.easeOut(duration: d.dur), value: go)
                }
            }
        }
        .onAppear { go = true }
    }
}
