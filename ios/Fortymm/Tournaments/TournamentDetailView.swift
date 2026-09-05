import SwiftUI
import MapKit

struct TournamentDetailView: View {
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dismiss) private var dismiss
    @StateObject private var store: TournamentStore<TournamentDTO>
    @State private var tab = DetailTab.events
    @State private var creatingEvent = false
    @State private var confirmingTransition = false
    @State private var busy = false
    @State private var error: String?
    @State private var match: FinalMatch?
    private let service: TournamentService

    init(id: UUID, service: TournamentService = TournamentService()) {
        self.service = service
        _store = StateObject(wrappedValue: TournamentStore(fetch: { try await service.detail(id) }))
    }
    enum DetailTab: String, CaseIterable { case events = "Events", schedule = "Schedule", tables = "Tables", details = "Details" }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if let tournament = store.value {
                        header(tournament)
                        Picker("Tournament section", selection: $tab) {
                            ForEach(DetailTab.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                        }.pickerStyle(.segmented)
                        if let message = error ?? store.refreshError { TournamentNotice(message: message) }
                        switch tab {
                        case .events:
                            if tournament.events.isEmpty { TournamentNotice(message: "No events yet. Dates will appear when an event is added.") }
                            ForEach(tournament.events) { event in
                                NavigationLink {
                                    TournamentEventView(tournamentStore: store, eventId: event.id, service: service)
                                } label: {
                                    FMCard {
                                        VStack(alignment: .leading, spacing: 10) {
                                            HStack { Text(event.name).font(FMFont.ui(20, weight: .bold)); Spacer(); Image(systemName: "chevron.right") }
                                            Text("\(event.format.capitalized) · \(tournament.drawName(event))")
                                            Text("\(event.slot.dateLabel) · \(event.slot.start)–\(event.slot.end) \(event.timezone)")
                                            HStack { Text(event.capacityLabel); Spacer(); Text(event.entryFee == 0 ? "Free entry" : "Entry fee: \(event.entryFee.formatted())") }
                                        }.font(FMFont.ui(13)).foregroundStyle(FMColor.fg1)
                                    }
                                }.buttonStyle(.plain)
                            }
                            if tournament.canEdit && [.draft, .published].contains(tournament.status) {
                                Button("Add event", systemImage: "plus") { creatingEvent = true }.buttonStyle(.borderedProminent)
                            }
                        case .schedule:
                            TournamentScheduleView(tournament: tournament, open: openMatch)
                        case .tables:
                            if tournament.tableCatalogue.isEmpty { TournamentNotice(message: "No tables have been assigned to this tournament.") }
                            ForEach(tournament.tableCatalogue) { table in
                                FMCard {
                                    VStack(alignment: .leading, spacing: 10) {
                                        Label(table.court.isEmpty ? table.label : "\(table.label) · \(table.court)", systemImage: "table.furniture")
                                        let events = tournament.events.filter { event in event.reservations?.contains { $0.tableIds.contains(table.id) } == true }
                                        if events.isEmpty { Text("Unused").font(FMFont.ui(12)).foregroundStyle(FMColor.fg3) }
                                        ForEach(events) { Text($0.name).font(FMFont.ui(13)).foregroundStyle(FMColor.fg3) }
                                    }
                                }
                            }
                        case .details:
                            FMCard {
                                VStack(alignment: .leading, spacing: 16) {
                                    Text(tournament.description.flatMap { $0.isEmpty ? nil : $0 } ?? "No description provided.")
                                    Label(tournament.address?.full ?? "Venue to be announced", systemImage: "mappin.and.ellipse")
                                    if let address = tournament.address, let latitude = address.latitude, let longitude = address.longitude,
                                       CLLocationCoordinate2DIsValid(CLLocationCoordinate2D(latitude: latitude, longitude: longitude)) {
                                        Map {
                                            Marker(address.venue.isEmpty ? tournament.name : address.venue, coordinate: CLLocationCoordinate2D(latitude: latitude, longitude: longitude))
                                        }.frame(height: 220).clipShape(RoundedRectangle(cornerRadius: 12))
                                        Button("Open in Maps", systemImage: "map") {
                                            let item = MKMapItem(placemark: MKPlacemark(coordinate: CLLocationCoordinate2D(latitude: latitude, longitude: longitude)))
                                            item.name = address.venue.isEmpty ? tournament.name : address.venue
                                            item.openInMaps()
                                        }
                                    }
                                    Label("Organized by \(tournament.createdByUsername)", systemImage: "person.crop.circle")
                                }.font(FMFont.ui(15))
                            }
                        }
                    } else {
                        switch store.state {
                        case .failed(let message): TournamentNotice(message: message) { Task { await store.load(force: true) } }
                        default: ProgressView().frame(maxWidth: .infinity).padding(40)
                        }
                    }
                }.padding(16)
            }
            .background(FMColor.bgApp.ignoresSafeArea()).foregroundStyle(FMColor.fg1)
            .navigationTitle("Tournament").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarLeading) { Button("Done") { dismiss() } } }
            .task { await store.load() }
            .task(id: "\(tab.rawValue)-\(scenePhase == .active)-\(store.value?.schedulePollSeconds ?? 0)") {
                guard tab == .schedule, scenePhase == .active else { return }
                while !Task.isCancelled, let seconds = store.value?.schedulePollSeconds {
                    do { try await Task.sleep(for: .seconds(seconds)) } catch { return }
                    guard !Task.isCancelled else { return }
                    await store.load(force: true)
                }
            }
            .refreshable { await store.load(force: true) }
            .refetchOnForeground { Task { await store.load(force: true) } }
            .sheet(isPresented: $creatingEvent) {
                if let tournament = store.value {
                    NewTournamentEventView(tournament: tournament, service: service) {
                        creatingEvent = false
                        Task { await store.load(force: true) }
                    }
                }
            }
            .confirmationDialog(store.value?.status.action ?? "", isPresented: $confirmingTransition, titleVisibility: .visible) {
                if let tournament = store.value, let next = tournament.status.next {
                    Button(tournament.status.action) {
                        busy = true
                        Task {
                            do { try await service.transition(tournament.id, to: next); error = nil; await store.load(force: true) }
                            catch { self.error = error.fmMessage }
                            busy = false
                        }
                    }
                }
            } message: { Text(store.value?.status.consequence ?? "") }
            .fullScreenCover(item: $match) { selected in
                MatchDetailView(initial: selected, onBack: { match = nil; Task { await store.load(force: true) } })
            }
            .overlay { if busy { FMBlockingSpinner() } }
        }.tint(FMColor.ball500).preferredColorScheme(.dark)
    }

    private func header(_ tournament: TournamentDTO) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            TournamentStatusBadge(status: tournament.status)
            Text(tournament.name).font(FMFont.display(34))
            Label(tournament.dateRange?.label ?? "Dates to be announced", systemImage: "calendar")
            Label(tournament.address?.label ?? "Venue to be announced", systemImage: "mappin.and.ellipse")
            Text([TournamentCopy.count(tournament.events.count, "event"), TournamentCopy.count(tournament.entryCount, "entry", plural: "entries"), TournamentCopy.count(tournament.tableCatalogue.count, "table")].joined(separator: " · "))
            if tournament.canEdit && tournament.status.next != nil {
                Button(tournament.status.action) { confirmingTransition = true }.buttonStyle(.borderedProminent).disabled(busy)
            }
        }.font(FMFont.ui(14))
    }

    private func openMatch(_ fixture: TournamentEventDTO.Fixture) {
        guard let id = fixture.matchId, !busy else { return }
        busy = true
        Task {
            do { match = try await MatchService.shared.matchDetails(id); error = nil }
            catch { self.error = error.fmMessage }
            busy = false
        }
    }
}

struct TournamentFixtureRow: View {
    let event: TournamentEventDTO
    let fixture: TournamentEventDTO.Fixture
    let tables: [TournamentDTO.Table]
    let open: () -> Void
    var body: some View {
        if fixture.matchId != nil {
            Button(action: open) { card }.buttonStyle(.plain)
        } else {
            card
        }
    }
    private var card: some View {
            FMCard {
                VStack(alignment: .leading, spacing: 9) {
                    HStack {
                        Text(event.fixtureHeading(fixture))
                        Spacer()
                        Text(fixture.statusLabel).foregroundStyle(fixture.winnerEntryId != nil ? FMColor.serve500 : FMColor.ball500)
                    }.font(FMFont.ui(12)).foregroundStyle(FMColor.fg3)
                    Text("\(event.player(fixture.entryAId)) vs \(event.player(fixture.entryBId))").font(FMFont.ui(16, weight: .semibold))
                    Text(fixture.scheduledStart?.label ?? "Unscheduled").font(FMFont.ui(13))
                    if let winner = fixture.winnerEntryId { Text("Winner: \(event.player(winner))").font(FMFont.ui(13)).foregroundStyle(FMColor.serve500) }
                    if fixture.tableOffReservation == true { Text("Table is outside the booked reservation").font(FMFont.ui(12)).foregroundStyle(FMColor.warn) }
                    if fixture.startOutsideReservationWindow == true { Text("Start is outside the booked time window").font(FMFont.ui(12)).foregroundStyle(FMColor.warn) }
                    HStack {
                        Text(tables.first { $0.id == fixture.tableId }?.label ?? "Table unassigned")
                        Spacer()
                        if fixture.matchId != nil { Label("View match", systemImage: "chevron.right") }
                    }.font(FMFont.ui(12)).foregroundStyle(FMColor.fg3)
                }
            }
    }
}
