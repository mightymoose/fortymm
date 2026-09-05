import SwiftUI

/// Three readings of the same schedule, adapted to a narrow iPhone screen.
struct TournamentScheduleView: View {
    let tournament: TournamentDTO
    let open: (TournamentEventDTO.Fixture) -> Void
    @State private var mode = Mode.list
    enum Mode: String, CaseIterable { case list = "List", tables = "Tables", players = "Players" }
    private struct Row: Identifiable {
        let event: TournamentEventDTO
        let fixture: TournamentEventDTO.Fixture
        var id: UUID { fixture.id }
    }
    private var rows: [Row] {
        tournament.events.flatMap { event in event.fixtures.map { Row(event: event, fixture: $0) } }
            .sorted {
                let left = $0.fixture.scheduledStart?.instant ?? .distantFuture
                let right = $1.fixture.scheduledStart?.instant ?? .distantFuture
                return left == right ? $0.id.uuidString < $1.id.uuidString : left < right
            }
    }
    private var players: [TournamentEventDTO.Entrant] {
        var seen = Set<UUID>()
        return tournament.events.flatMap(\.entrants).filter { seen.insert($0.userId).inserted }.sorted { $0.username.localizedStandardCompare($1.username) == .orderedAscending }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if let solve = tournament.latestScheduleSolve {
                FMCard {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(solve.label).font(FMFont.ui(15, weight: .semibold))
                        if let placed = solve.fixturesPlaced { Text("\(placed) fixtures placed").font(FMFont.ui(13)) }
                        if solve.overrunning { Text("Play is running beyond the planned schedule.").foregroundStyle(FMColor.warn) }
                        if let error = solve.error { Text(error).font(FMFont.ui(13)).foregroundStyle(FMColor.fg3) }
                    }
                }
            } else { Text("No automatic schedule yet.").font(FMFont.ui(13)).foregroundStyle(FMColor.fg3) }
            if rows.isEmpty {
                TournamentNotice(message: "The schedule will appear after event draws are cut.")
            } else {
                Picker("Schedule view", selection: $mode) {
                    ForEach(Mode.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }.pickerStyle(.segmented)
                Text("Times are estimates until a match is called. Each time is shown in its event’s time zone.")
                    .font(FMFont.ui(12)).foregroundStyle(FMColor.fg3)
                switch mode {
                case .list: section("Matches", rows: rows)
                case .tables:
                    ForEach(tournament.tableCatalogue) { table in
                        section(table.court.isEmpty ? table.label : "\(table.label) · \(table.court)", rows: rows.filter { $0.fixture.tableId == table.id })
                    }
                    section("Unassigned", rows: rows.filter { $0.fixture.tableId == nil })
                case .players:
                    ForEach(players, id: \.userId) { player in
                        section(player.username, rows: rows.filter { row in
                            let entries = row.event.entrants.filter { $0.userId == player.userId }.map(\.id)
                            return entries.contains { $0 == row.fixture.entryAId || $0 == row.fixture.entryBId }
                        })
                    }
                    section("Players to be determined", rows: rows.filter { $0.fixture.entryAId == nil && $0.fixture.entryBId == nil })
                }
            }
        }
    }
    @ViewBuilder private func section(_ name: String, rows: [Row]) -> some View {
        if !rows.isEmpty {
            Text(name).font(FMFont.ui(20, weight: .bold))
            ForEach(rows) { row in
                VStack(alignment: .leading, spacing: 6) {
                    Text("\(row.event.name) · \(row.event.slot.dateLabel)").font(FMFont.ui(12)).foregroundStyle(FMColor.fg3)
                    TournamentFixtureRow(event: row.event, fixture: row.fixture, tables: tournament.tableCatalogue) { open(row.fixture) }
                }
            }
        }
    }
}
