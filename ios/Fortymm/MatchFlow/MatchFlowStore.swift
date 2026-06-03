import Combine
import SwiftUI

/// Holds the (seed) matches list and season record shared between the Matches
/// tab and the new-match flow. UI-only: posting a result just prepends in memory
/// — no networking yet.
@MainActor
final class MatchFlowStore: ObservableObject {
    @Published var matches: [FinalMatch] = MatchSeed.matches
    @Published var record = SeasonRecord()

    func post(_ match: FinalMatch) {
        matches.insert(match, at: 0)
        record.record(win: match.win)
    }
}
