import SwiftUI

struct TournamentEventView: View {
    @ObservedObject var tournamentStore: TournamentStore<TournamentDTO>
    let eventId: UUID
    let service: TournamentService
    @EnvironmentObject private var session: SessionStore
    @State private var section = EventSection.players
    @State private var busy = false
    @State private var error: String?
    @State private var confirmingWithdrawal = false
    @State private var match: FinalMatch?
    enum EventSection: String, CaseIterable { case players = "Players", draw = "Draw", results = "Results", details = "Details" }

    var body: some View {
        ScrollView {
            if let tournament = tournamentStore.value, let event = tournament.events.first(where: { $0.id == eventId }) {
                VStack(alignment: .leading, spacing: 18) {
                    Text(event.name).font(FMFont.display(32))
                    Text("\(event.format.capitalized) · \(tournament.drawName(event))").font(FMFont.ui(15))
                    Label("\(event.slot.dateLabel) · \(event.slot.start)–\(event.slot.end) \(event.timezone)", systemImage: "calendar").font(FMFont.ui(13))
                    registration(tournament, event)
                    if let message = error ?? tournamentStore.refreshError { TournamentNotice(message: message) }
                    Picker("Event section", selection: $section) {
                        ForEach(EventSection.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                    }.pickerStyle(.segmented)
                    switch section {
                    case .players:
                        Text(event.capacityLabel).font(FMFont.ui(14, weight: .semibold))
                        if event.entrants.isEmpty { TournamentNotice(message: "No players entered yet.") }
                        ForEach(event.entrants) { entrant in
                            FMCard {
                                HStack {
                                    Image(systemName: "person.crop.circle").foregroundStyle(FMColor.ball500)
                                    Text(entrant.username).font(FMFont.ui(16, weight: .semibold))
                                    if entrant.userId == session.user?.id { Text("You").font(FMFont.ui(12)).foregroundStyle(FMColor.ball500) }
                                    Spacer()
                                    Text(entrant.rating.map { String(Int($0.rounded())) } ?? "Unrated").font(FMFont.mono(13))
                                }
                            }
                        }
                    case .draw:
                        if event.fixtures.isEmpty { TournamentNotice(message: "The draw has not been cut yet.") }
                        if event.canCutDraw(status: tournament.status, canEdit: tournament.canEdit) {
                            Button(event.fixtures.isEmpty ? "Cut draw" : "Re-cut draw") { mutate { try await service.cutDraw(tournament.id, event: event.id) } }
                                .buttonStyle(.borderedProminent).disabled(busy || event.entrants.count < 2)
                        }
                        ForEach(event.stages.sorted { $0.position < $1.position }) { stage in
                            Text("Stage \(stage.position + 1) · \(stage.drawType.replacingOccurrences(of: "-", with: " ").capitalized)")
                                .font(FMFont.ui(18, weight: .bold))
                            ForEach(event.fixtures.filter { $0.stageId == stage.id }) { fixture in
                                TournamentFixtureRow(event: event, fixture: fixture, tables: tournament.tableCatalogue) {
                                    guard let id = fixture.matchId else { return }
                                    busy = true
                                    Task {
                                        do { match = try await MatchService.shared.matchDetails(id); error = nil }
                                        catch { self.error = error.fmMessage }
                                        busy = false
                                    }
                                }
                            }
                        }
                    case .results:
                        results(event)
                    case .details:
                        eventDetails(event, tournament: tournament)
                    }
                }.padding(16)
                .confirmationDialog("Withdraw from \(event.name)?", isPresented: $confirmingWithdrawal, titleVisibility: .visible) {
                    if let entry = event.entrants.first(where: { $0.userId == session.user?.id }) {
                        Button("Withdraw", role: .destructive) { mutate { try await service.withdraw(tournament.id, event: event.id, entry: entry.id) } }
                    }
                } message: { Text("Your place will be released. You can enter again while registration is open, if space remains.") }
            } else {
                TournamentNotice(message: "This event is no longer available.")
            }
        }
        .background(FMColor.bgApp.ignoresSafeArea()).foregroundStyle(FMColor.fg1)
        .navigationTitle("Event").navigationBarTitleDisplayMode(.inline)
        .refreshable { await tournamentStore.load(force: true) }
        .overlay { if busy { FMBlockingSpinner() } }
        .fullScreenCover(item: $match) { selected in
            MatchDetailView(initial: selected, onBack: { match = nil; Task { await tournamentStore.load(force: true) } })
        }
    }

    @ViewBuilder
    private func registration(_ tournament: TournamentDTO, _ event: TournamentEventDTO) -> some View {
        if event.format == "singles", session.user != nil {
            if tournament.status != .published {
                Text(tournament.status == .draft ? "Registration has not opened yet." : "Registration is closed.")
                    .font(FMFont.ui(14)).foregroundStyle(FMColor.fg3)
            } else if event.entrants.contains(where: { $0.userId == session.user?.id }) {
                HStack {
                    Label("You're entered", systemImage: "checkmark.circle.fill").foregroundStyle(FMColor.serve500)
                    Spacer()
                    Button("Withdraw", role: .destructive) { confirmingWithdrawal = true }.disabled(busy)
                }.font(FMFont.ui(14))
            } else {
                switch event.entryState.state {
                case .open:
                    Button("Enter event") { mutate { try await service.enter(tournament.id, event: event.id) } }
                        .buttonStyle(.borderedProminent).disabled(busy)
                case .full: TournamentNotice(message: "This event is full. A place may open if another player withdraws.")
                case .ineligible: TournamentNotice(message: event.ineligibilityMessage)
                case .unknown: TournamentNotice(message: "Entry is currently unavailable. Refresh to check again.")
                }
            }
        }
    }

    @ViewBuilder
    private func results(_ event: TournamentEventDTO) -> some View {
        if let result = event.results {
            if let champion = result.champion {
                Label("Champion: \(event.player(champion))", systemImage: "trophy.fill")
                    .font(FMFont.ui(20, weight: .bold)).foregroundStyle(FMColor.ball500)
            }
            if !result.complete { Text("Results update as matches finish.").font(FMFont.ui(13)).foregroundStyle(FMColor.fg3) }
            ForEach(result.groups ?? []) { group in
                Text(event.groupLabel(group.groupId)).font(FMFont.ui(18, weight: .bold))
                standings(group.rows, event: event)
            }
            if let rows = result.rows { standings(rows, event: event) }
            if let finishes = result.finishes, !finishes.isEmpty {
                Text("Placements").font(FMFont.ui(18, weight: .bold))
                ForEach(finishes) { finish in
                    FMCard { HStack { Text("#\(finish.position)").font(FMFont.mono(18)); Text(event.player(finish.entryId)).font(FMFont.ui(16, weight: .semibold)) } }
                }
            }
            if !["standings", "finishes", "standings_then_finishes", "swiss_standings"].contains(result.kind) {
                TournamentNotice(message: "This results format is not supported in this version of the app.")
            }
        } else { TournamentNotice(message: "Results will appear after the draw is cut and matches are played.") }
    }

    @ViewBuilder
    private func eventDetails(_ event: TournamentEventDTO, tournament: TournamentDTO) -> some View {
        FMCard {
            VStack(alignment: .leading, spacing: 12) {
                Text("Event details").font(FMFont.ui(20, weight: .bold))
                Text(event.capacityLabel)
                Text(event.entryFee == 0 ? "Free entry" : "Entry fee: \(event.entryFee.formatted())")
                if let settings = event.matchSettings {
                    Text("\(settings.rated ? "Rated" : "Unrated") · Best of \(settings.lengthGames) games")
                }
                if let rounds = event.rounds { Text("\(rounds) Swiss rounds") }
                if let qualifiers = event.qualifiersPerGroup { Text("\(qualifiers) qualifiers per group advance to knockout") }
                if let format = tournament.drawTypeCatalogue?.first(where: { $0.key == event.drawType }) { Text(format.description).foregroundStyle(FMColor.fg3) }
            }.font(FMFont.ui(14))
        }
        FMCard {
            VStack(alignment: .leading, spacing: 12) {
                Text("Eligibility").font(FMFont.ui(20, weight: .bold))
                if let predicates = event.predicates, !predicates.isEmpty {
                    ForEach(predicates) { Text($0.label) }
                    Text("Unrated players satisfy rating restrictions. Registration and capacity limits still apply.").foregroundStyle(FMColor.fg3)
                } else { Text("No rating restrictions.") }
            }.font(FMFont.ui(14))
        }
        Text("Reservations").font(FMFont.ui(20, weight: .bold))
        if event.reservations?.isEmpty != false { TournamentNotice(message: "No separate reservations. This event uses its scheduled window and the tournament’s table catalogue.") }
        ForEach(event.reservations ?? []) { reservation in
            FMCard {
                VStack(alignment: .leading, spacing: 10) {
                    Text(reservation.name).font(FMFont.ui(16, weight: .semibold))
                    Text("\(reservation.slot.dateLabel) · \(reservation.slot.start)–\(reservation.slot.end) \(event.timezone)")
                    ForEach(reservation.tableIds, id: \.self) { id in
                        if let table = tournament.tableCatalogue.first(where: { $0.id == id }) {
                            Label(table.court.isEmpty ? table.label : "\(table.label) · \(table.court)", systemImage: "table.furniture")
                        }
                    }
                }.font(FMFont.ui(13))
            }
        }
    }

    private func standings(_ rows: [TournamentEventDTO.Results.Standing], event: TournamentEventDTO) -> some View {
        FMCard {
            ScrollView(.horizontal) {
                Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 12) {
                    GridRow {
                        Text("Rank"); Text("Player"); Text("Played"); Text("W"); Text("L")
                        Text("Games +"); Text("Games −"); Text("Diff")
                        if event.results?.kind == "swiss_standings" { Text("Buchholz") }
                    }.font(FMFont.ui(12, weight: .semibold)).foregroundStyle(FMColor.fg3)
                    ForEach(rows) { row in
                        GridRow {
                            Text("\(row.rank)").foregroundStyle(FMColor.ball500)
                            Text(event.player(row.entryId)).font(FMFont.ui(14, weight: .semibold))
                            Text("\(row.played)"); Text("\(row.wins)"); Text("\(row.losses)")
                            Text("\(row.gamesWon)"); Text("\(row.gamesLost)"); Text("\(row.gamesWon - row.gamesLost)")
                            if event.results?.kind == "swiss_standings" { Text(row.buchholz.map(String.init) ?? "—") }
                        }.font(FMFont.mono(13))
                    }
                }.fixedSize(horizontal: true, vertical: false)
            }
        }
    }

    private func mutate(_ action: @escaping () async throws -> Void) {
        guard !busy else { return }
        busy = true
        Task {
            do { try await action(); error = nil; await tournamentStore.load(force: true) }
            catch { self.error = error.fmMessage }
            busy = false
        }
    }
}
