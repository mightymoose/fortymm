import SwiftUI

// MARK: - Shared bits

/// Small uppercase label used inside the dashboard cards. Mirrors the web
/// `Overline` (no leading dot, unlike `FMEyebrow`).
struct DashOverline: View {
    let text: String
    var size: CGFloat = FMFont.xs

    var body: some View {
        Text(text.uppercased())
            .font(FMFont.mono(size, weight: .medium))
            .tracking(1.4)
            .foregroundStyle(FMColor.fgMuted)
    }
}

enum DashPillTone {
    case win, loss

    var fg: Color { self == .win ? FMColor.serve500 : FMColor.loss }
    var bg: Color { fg.opacity(0.12) }
}

/// Rounded mono pill — the streak ("L4") and per-match delta ("−88 last match").
private struct DashPill: View {
    let text: String
    let tone: DashPillTone

    var body: some View {
        Text(text)
            .font(FMFont.mono(FMFont.xs, weight: .semibold))
            .foregroundStyle(tone.fg)
            .padding(.horizontal, 9)
            .padding(.vertical, 3)
            .background(tone.bg, in: Capsule())
    }
}

/// The rating card's toned "+12 last match" chip.
///
/// Takes a NON-OPTIONAL delta on purpose, mirroring the web client's `DeltaPill`
/// (`web-client/src/components/dashboard/your-game-row/rating-card/delta-pill.tsx`):
/// the chip has to pick a direction and a tone, and neither exists for a rating
/// that was ESTABLISHED rather than moved. Making the absent case unrepresentable
/// here means a call site cannot render "+0 last match" under a brand-new
/// player's first rating (#952) — it has to unwrap first, or render nothing.
private struct DashDeltaPill: View {
    let delta: Double

    var body: some View {
        DashPill(
            text: "\(signedRating(delta)) last match",
            tone: delta >= 0 ? .win : .loss
        )
    }
}

/// A single stat tile in the rating card's 3-up grid (Peak / RD / Volatility…).
private struct DashStatTile: View {
    let label: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            DashOverline(text: label, size: 9)
            Text(value)
                .font(FMFont.mono(FMFont.base, weight: .bold))
                .foregroundStyle(FMColor.fg1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .dashInsetBox()
    }
}

/// Signed integer label, e.g. `+12` / `-88`. Negative values already carry a
/// minus, so only positives need the explicit `+`.
private func signedRating(_ value: Double) -> String {
    let n = Int(value.rounded())
    return n >= 0 ? "+\(n)" : "\(n)"
}

/// A rounded rating as a plain digit string, e.g. `1500` — no locale grouping
/// separator (the design shows bare four-digit ratings, not "1,500").
private func plainRating(_ value: Double) -> String {
    String(Int(value.rounded()))
}

private extension View {
    /// The inset "well" shared by the sparkline panel and the stat tiles: a
    /// darker fill with a hairline border.
    func dashInsetBox() -> some View {
        background(FMColor.ink900)
            .fmRoundedBorder(radius: FMRadius.md, color: FMColor.ink700)
    }
}

// MARK: - Current rating card

struct DashboardRatingCard: View {
    let rating: DashboardRating

    // Peak tile, then up to two strategy-specific stats (the grid is 3-up).
    private var tiles: [(label: String, value: String)] {
        [("Peak", plainRating(rating.peak))]
            + rating.stats.prefix(2).map { ($0.label, $0.value) }
    }

    var body: some View {
        FMCard {
            VStack(alignment: .leading, spacing: FMSpace.s4) {
                HStack {
                    DashOverline(text: "Current rating")
                    Spacer()
                    if let streak = rating.streak {
                        DashPill(
                            text: "\(streak.kind)\(streak.n)",
                            tone: streak.kind == "W" ? .win : .loss
                        )
                    }
                }

                HStack(alignment: .firstTextBaseline, spacing: FMSpace.s3) {
                    Text(verbatim: plainRating(rating.current))
                        .font(FMFont.mono(56, weight: .bold))
                        .foregroundStyle(FMColor.fg1)
                    VStack(alignment: .leading, spacing: 5) {
                        // No delta ⇒ NO CHIP. A `nil` delta means the player's
                        // last rated match ESTABLISHED this rating instead of
                        // moving it, so there is no movement to report: the big
                        // number beside this already says everything that
                        // happened. The 1500 a league-join seeds is not a rating
                        // anyone held to fall from — "−232 last match" under a
                        // 1268 was exactly that phantom (#952) — and a "+0"
                        // would claim a rated match moved nothing.
                        if let delta = rating.delta {
                            DashDeltaPill(delta: delta)
                        }
                        percentileLine
                    }
                }

                sparklineBox

                HStack(spacing: FMSpace.s2) {
                    ForEach(tiles, id: \.label) { tile in
                        DashStatTile(label: tile.label, value: tile.value)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var percentileLine: some View {
        if let percentile = rating.percentile {
            (Text("Top ").foregroundStyle(FMColor.fgMuted)
                + Text("\(percentile)%")
                    .font(FMFont.mono(FMFont.xs))
                    .foregroundStyle(FMColor.fg3)
                + Text(" in \(rating.leagueName)").foregroundStyle(FMColor.fgMuted))
                .font(FMFont.ui(FMFont.xs))
        } else {
            Text(rating.leagueName)
                .font(FMFont.ui(FMFont.xs))
                .foregroundStyle(FMColor.fgMuted)
        }
    }

    private var sparklineBox: some View {
        VStack(spacing: 6) {
            DashboardSparkline(data: rating.sparkData)
            HStack {
                Text("30 days ago")
                Spacer()
                Text(verbatim: "Today · peak \(plainRating(rating.peak))")
            }
            .font(FMFont.mono(10))
            .tracking(0.8)
            .foregroundStyle(FMColor.fgMuted)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .dashInsetBox()
    }
}

// MARK: - Recent matches card

struct DashboardRecentResultsCard: View {
    let rows: [DashboardRecentResult]

    private var wins: Int { rows.filter(\.isWin).count }

    private static let dayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "MMM d"   // e.g. "Jun 3"
        return f
    }()

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                DashOverline(text: "Recent matches")
                Spacer()
                (Text("\(wins)-\(rows.count - wins)")
                    .font(FMFont.mono(FMFont.xs))
                    .foregroundStyle(FMColor.fg2)
                    + Text(" · last \(rows.count)")
                    .font(FMFont.ui(FMFont.xs))
                    .foregroundStyle(FMColor.fgMuted))
            }
            .padding(.horizontal, FMSpace.s4)
            .padding(.top, FMSpace.s4)
            .padding(.bottom, FMSpace.s3)

            Rectangle().fill(FMColor.ink700).frame(height: 1)

            if rows.isEmpty {
                Text("No completed matches yet.")
                    .font(FMFont.ui(FMFont.sm))
                    .foregroundStyle(FMColor.fg3)
                    .padding(FMSpace.s4)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                ForEach(Array(rows.enumerated()), id: \.element.id) { i, row in
                    if i > 0 { Rectangle().fill(FMColor.ink700).frame(height: 1) }
                    resultRow(row)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(FMColor.bgCard)
        .fmRoundedBorder(radius: FMRadius.lg, color: FMColor.borderSubtle)
    }

    private func resultRow(_ row: DashboardRecentResult) -> some View {
        let opponent = row.opponentUsername
        let tint = row.isWin ? FMColor.serve500 : FMColor.loss
        return HStack(spacing: FMSpace.s2) {
            Circle()
                .fill(tint)
                .frame(width: 6, height: 6)
                .shadow(color: tint.opacity(0.5), radius: 3)
            FMAvatar(
                initials: (opponent ?? "?").fmInitials,
                size: 24,
                color: FMColor.ink600,
                foreground: FMColor.fg2
            )
            Text(opponent ?? "No opponent")
                .font(FMFont.ui(FMFont.sm, weight: .medium))
                .foregroundStyle(opponent == nil ? FMColor.fgMuted : FMColor.fg1)
                .italic(opponent == nil)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)

            Text("\(row.myGamesWon)-\(row.opponentGamesWon)")
                .font(FMFont.mono(FMFont.sm, weight: .medium))
                .foregroundStyle(tint)

            // Two nils, one em dash. `myRatingChange` is nil when the match
            // moved no rating at all; a *present* change whose `delta` is nil is
            // the player's FIRST rated match — it established their rating
            // rather than moving it, so there is no movement to report here
            // either. Never a signed figure off the seeded 1500 (#952). Matches
            // the web client's recent-results column.
            Group {
                if let delta = row.myRatingChange?.delta {
                    Text(signedRating(delta))
                        .foregroundStyle(delta >= 0 ? FMColor.serve500 : FMColor.loss)
                } else {
                    Text("—").foregroundStyle(FMColor.fgMuted)
                }
            }
            .font(FMFont.mono(FMFont.xs, weight: .medium))
            .frame(width: 46, alignment: .trailing)

            Text(Self.dayFormatter.string(from: row.completedAt))
                .font(FMFont.mono(FMFont.xs))
                .foregroundStyle(FMColor.fgMuted)
                .frame(width: 48, alignment: .trailing)
        }
        .padding(.horizontal, FMSpace.s4)
        .padding(.vertical, 11)
    }
}
