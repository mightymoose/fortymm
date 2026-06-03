import SwiftUI

/// The signed-in landing surface. Shows the "Your game" widgets — the current
/// rating card (with sparkline) and the recent-matches table — fed by the BFF
/// endpoint `GET /v1/dashboard`. Mirrors the web dashboard's "Your game" row.
struct DashboardView: View {
    @StateObject private var store = DashboardStore()

    private static let longDate: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "EEEE, MMMM d"   // e.g. "Wednesday, June 3"
        return f
    }()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: FMSpace.s6) {
                content
            }
            .padding(.horizontal, FMSpace.s5)
            // The shell's frosted top bar (~46pt) is laid over the top via the
            // TabView's `.safeAreaInset`, and that inset doesn't fully reduce the
            // scroll content's safe area inside the tab — so content renders under
            // the bar. Clear it with a top pad of the bar height plus a small gap,
            // otherwise the "Dashboard · <date>" overline is hidden behind the bar.
            .padding(.top, 56)
            .padding(.bottom, FMSpace.s6)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(FMColor.bgApp.ignoresSafeArea())
        .refreshable { await store.load(force: true) }
        .task { await store.load() }
    }

    @ViewBuilder
    private var content: some View {
        switch store.state {
        case .idle, .loading:
            header(greeting: "Hi")
            loadingCard
        case let .loaded(loaded):
            header(greeting: "Hi, @\(loaded.username)")
            yourGame(loaded.dashboard)
        case let .failed(message):
            header(greeting: "Hi")
            errorCard(message)
        }
    }

    private func header(greeting: String) -> some View {
        VStack(alignment: .leading, spacing: FMSpace.s2) {
            DashOverline(text: "Dashboard · \(Self.longDate.string(from: Date()))")
            (Text(greeting).foregroundStyle(FMColor.fg1)
                + Text(".").foregroundStyle(FMColor.ball500))
                .font(FMFont.ui(FMFont.xl2, weight: .bold))
        }
    }

    @ViewBuilder
    private func yourGame(_ data: DashboardResponse) -> some View {
        VStack(alignment: .leading, spacing: FMSpace.s4) {
            HStack(alignment: .firstTextBaseline, spacing: FMSpace.s3) {
                Text("Your game")
                    .font(FMFont.ui(FMFont.md, weight: .semibold))
                    .foregroundStyle(FMColor.fg1)
                Text(yourGameSubtitle(data.rating))
                    .font(FMFont.ui(FMFont.sm))
                    .foregroundStyle(FMColor.fgMuted)
                Spacer()
            }

            if let rating = data.rating {
                DashboardRatingCard(rating: rating)
            } else {
                FMCard {
                    VStack(alignment: .leading, spacing: FMSpace.s3) {
                        DashOverline(text: "Current rating")
                        Text("Not in a rated league yet.")
                            .font(FMFont.ui(FMFont.sm))
                            .foregroundStyle(FMColor.fg3)
                    }
                }
            }

            DashboardRecentResultsCard(rows: data.recentResults)
        }
    }

    private func yourGameSubtitle(_ rating: DashboardRating?) -> String {
        guard let rating else { return "Last 30 days" }
        return "\(rating.strategyLabel) · last 30 days"
    }

    private var loadingCard: some View {
        FMCard {
            HStack(spacing: FMSpace.s3) {
                ProgressView()
                    .tint(FMColor.ball500)
                Text("Loading your dashboard…")
                    .font(FMFont.ui(FMFont.md))
                    .foregroundStyle(FMColor.fg3)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func errorCard(_ message: String) -> some View {
        FMCard {
            VStack(alignment: .leading, spacing: FMSpace.s4) {
                Text("Couldn't load your dashboard")
                    .font(FMFont.ui(FMFont.md, weight: .semibold))
                    .foregroundStyle(FMColor.fg1)
                Text(message)
                    .font(FMFont.ui(FMFont.sm))
                    .foregroundStyle(FMColor.fg3)
                    .lineSpacing(2)
                FMButton(title: "Try again", variant: .primary, size: .md) {
                    Task { await store.load(force: true) }
                }
            }
        }
    }
}

#Preview {
    NavigationStack {
        DashboardView()
    }
    .preferredColorScheme(.dark)
}
