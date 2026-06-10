import SwiftUI

/// Presents a match's detail from just its id — the entry point for a tapped
/// confirm/dispute push notification, where all we carry is the `match_id`.
///
/// `MatchDetailView` needs a `FinalMatch` in hand (it renders immediately, then
/// refetches), so this fetches the match first and shows a spinner meanwhile.
/// On failure it offers a retry rather than dropping the user on a blank screen.
struct MatchDetailLoaderView: View {
    let matchId: UUID
    var service: MatchService = .shared
    var onClose: () -> Void

    @State private var match: FinalMatch?
    @State private var loadError: String?

    var body: some View {
        ZStack {
            FMColor.bgApp.ignoresSafeArea()
            if let match {
                MatchDetailView(initial: match, onBack: onClose)
            } else if let loadError {
                errorState(loadError)
            } else {
                ProgressView()
                    .tint(FMColor.ball500)
            }
        }
        .task { await load() }
    }

    private func load() async {
        loadError = nil
        do {
            match = try await service.matchDetails(matchId)
        } catch {
            loadError = error.fmMessage
        }
    }

    private func errorState(_ message: String) -> some View {
        VStack(spacing: FMSpace.s5) {
            FMLogo(size: 30)
            VStack(spacing: FMSpace.s2) {
                Text("Couldn't open that match")
                    .font(FMFont.ui(FMFont.md, weight: .semibold))
                    .foregroundStyle(FMColor.fg1)
                Text(message)
                    .font(FMFont.ui(FMFont.sm))
                    .foregroundStyle(FMColor.fg3)
                    .multilineTextAlignment(.center)
                    .lineSpacing(2)
            }
            FMButton(title: "Try again", variant: .primary, size: .md) {
                Task { await load() }
            }
            FMButton(title: "Close", variant: .ghost, size: .md, action: onClose)
        }
        .padding(.horizontal, FMSpace.s6)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
