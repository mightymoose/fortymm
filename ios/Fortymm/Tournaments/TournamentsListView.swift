import SwiftUI

struct TournamentsListView: View {
    var isSelected: Bool
    @EnvironmentObject private var session: SessionStore
    @StateObject private var store: TournamentStore<[TournamentDTO]>
    @StateObject private var location: TournamentLocation
    init(isSelected: Bool = false) {
        self.isSelected = isSelected
        let location = TournamentLocation()
        _location = StateObject(wrappedValue: location)
        _store = StateObject(wrappedValue: TournamentStore(fetch: { try await TournamentService().list(nearMe: location.filter) }))
    }
    @State private var query = ""
    @State private var filter: TournamentStatus?
    @State private var mine = false
    @State private var selected: TournamentDestination?
    @State private var creating = false
    @State private var createdID: UUID?

    private var tournaments: [TournamentDTO] {
        (store.value ?? []).filter { tournament in
            (filter == nil || tournament.status == filter) &&
            (!mine || tournament.canEdit || tournament.events.contains { $0.entrants.contains { $0.userId == session.user?.id } }) &&
            (query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || tournament.name.localizedStandardContains(query.trimmingCharacters(in: .whitespacesAndNewlines)))
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack {
                    Text("Find your next tournament")
                        .font(FMFont.display(28))
                    Spacer()
                    if session.user?.permissions.contains("tournament.create") == true {
                        Button { creating = true } label: { Image(systemName: "plus.circle.fill").font(.title) }
                            .accessibilityLabel("New tournament")
                    }
                }
                HStack {
                    Image(systemName: "magnifyingglass").foregroundStyle(FMColor.fg3)
                    TextField("Search tournaments by name", text: $query)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("tournaments.search")
                    if !query.isEmpty { Button { query = "" } label: { Image(systemName: "xmark.circle.fill") }.accessibilityLabel("Clear search") }
                }
                .padding(12).background(FMColor.bgCard).clipShape(RoundedRectangle(cornerRadius: 10))
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        filterButton("All", status: nil)
                        ForEach(TournamentStatus.allCases.filter { $0 != .unknown }) { status in
                            filterButton(status.label, status: status)
                        }
                    }
                }
                HStack {
                    Toggle("Near me", isOn: Binding(get: { location.enabled }, set: { location.setEnabled($0) }))
                        .accessibilityIdentifier("tournaments.nearMe")
                    Picker("Search radius", selection: $location.radiusMiles) {
                        ForEach([25, 50, 100], id: \.self) { Text("\($0) mi").tag($0) }
                    }.fixedSize()
                }.font(FMFont.ui(14))
                if location.locating { ProgressView("Locating…") }
                if let message = location.message { TournamentNotice(message: message) }
                Toggle("My tournaments", isOn: $mine).font(FMFont.ui(14))
                Text(TournamentCopy.count(tournaments.count, "result")).font(FMFont.ui(12)).foregroundStyle(FMColor.fg3)
                if let error = store.refreshError { TournamentNotice(message: error) { Task { await store.load(force: true) } } }
                switch store.state {
                case .idle, .loading:
                    ProgressView().frame(maxWidth: .infinity).padding(40)
                case .failed(let message):
                    TournamentNotice(message: message) { Task { await store.load(force: true) } }
                case .loaded:
                    if tournaments.isEmpty {
                        ContentUnavailableView("No tournaments found", systemImage: "trophy", description: Text("Try another search, status, or distance filter."))
                    }
                    ForEach(tournaments) { tournament in
                        Button { selected = TournamentDestination(id: tournament.id) } label: {
                            FMCard {
                                VStack(alignment: .leading, spacing: 12) {
                                    HStack { TournamentStatusBadge(status: tournament.status); Spacer(); Image(systemName: "chevron.right").foregroundStyle(FMColor.fgMuted) }
                                    Text(tournament.name).font(FMFont.ui(22, weight: .bold)).multilineTextAlignment(.leading)
                                    Label(tournament.dateRange?.label ?? "Dates to be announced", systemImage: "calendar")
                                    Label(tournament.address?.label ?? "Venue to be announced", systemImage: "mappin.and.ellipse")
                                    if let distance = tournament.distanceMiles { Text("\(distance.formatted(.number.precision(.fractionLength(1)))) mi away").foregroundStyle(FMColor.ball500) }
                                    Divider()
                                    HStack {
                                        Label(TournamentCopy.count(tournament.events.count, "event"), systemImage: "trophy")
                                        Spacer()
                                        Label(TournamentCopy.count(tournament.entryCount, "entry", plural: "entries"), systemImage: "person.2")
                                    }
                                }
                                .font(FMFont.ui(13)).foregroundStyle(FMColor.fg1)
                            }
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("tournaments.row.\(tournament.id)")
                    }
                }
            }
            .padding(16)
        }
        .background(FMColor.bgApp.ignoresSafeArea())
        .foregroundStyle(FMColor.fg1)
        .tint(FMColor.ball500)
        .task { await store.load() }
        .onChange(of: location.filter) { _, _ in Task { await store.load(force: true, preservingContent: false) } }
        .refreshable { await store.load(force: true) }
        .refetchWhenSelected(isSelected) { Task { await store.load(force: true) } }
        .refetchOnForeground { Task { await store.load(force: true) } }
        .fullScreenCover(item: $selected, onDismiss: { Task { await store.load(force: true) } }) { destination in
            TournamentDetailView(id: destination.id)
        }
        .sheet(isPresented: $creating, onDismiss: {
            if let id = createdID {
                createdID = nil
                selected = TournamentDestination(id: id)
            }
        }) {
            NewTournamentView { id in
                createdID = id
                creating = false
            }
        }
    }

    private func filterButton(_ label: String, status: TournamentStatus?) -> some View {
        Button { filter = status } label: {
            Text(label).font(FMFont.ui(13, weight: .semibold))
                .padding(.horizontal, 14).padding(.vertical, 10)
                .background(filter == status ? FMColor.ball500 : FMColor.bgCard)
                .foregroundStyle(filter == status ? FMColor.fgInverse : FMColor.fg3)
                .clipShape(Capsule())
        }.buttonStyle(.plain)
        .accessibilityAddTraits(filter == status ? .isSelected : [])
    }
}

struct TournamentDestination: Identifiable { let id: UUID }

struct TournamentStatusBadge: View {
    let status: TournamentStatus
    var body: some View {
        Text(status.label).font(FMFont.ui(12, weight: .semibold))
            .foregroundStyle(status == .live ? FMColor.serve500 : FMColor.ball500)
            .padding(.horizontal, 10).padding(.vertical, 5)
            .background((status == .live ? FMColor.serve500 : FMColor.ball500).opacity(0.12))
            .clipShape(Capsule())
    }
}

struct TournamentNotice: View {
    let message: String
    var retry: (() -> Void)? = nil
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(message).font(FMFont.ui(14)).foregroundStyle(FMColor.fg3)
            if let retry { Button("Try again", action: retry) }
        }.padding().frame(maxWidth: .infinity, alignment: .leading)
    }
}
