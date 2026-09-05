import SwiftUI

struct NewTournamentView: View {
    let onCreated: (UUID) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var description = ""
    @State private var saving = false
    @State private var error: String?
    var body: some View {
        NavigationStack {
            Form {
                Section("Tournament") {
                    TextField("Name", text: $name)
                    TextField("Description (optional)", text: $description, axis: .vertical).lineLimit(3...6)
                }
                Section { Text("Your tournament starts as a draft. Add events to set its dates, then publish to open registration.") }
                if let error { Section { Text(error).foregroundStyle(FMColor.loss) } }
            }
            .navigationTitle("New tournament").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(saving) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Creating…" : "Create") {
                        saving = true
                        Task {
                            do {
                                let id = try await TournamentService().create(name: name.trimmingCharacters(in: .whitespacesAndNewlines), description: description)
                                onCreated(id)
                            } catch { self.error = error.fmMessage }
                            saving = false
                        }
                    }.disabled(saving || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || name.count > 255 || description.count > 1024)
                }
            }.interactiveDismissDisabled(saving)
        }.tint(FMColor.ball500).preferredColorScheme(.dark)
    }
}

struct NewTournamentEventView: View {
    let tournament: TournamentDTO
    let service: TournamentService
    let onCreated: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var drawType = ""
    @State private var date = Date()
    @State private var start = Calendar.current.date(bySettingHour: 9, minute: 0, second: 0, of: Date()) ?? Date()
    @State private var end = Calendar.current.date(bySettingHour: 17, minute: 0, second: 0, of: Date()) ?? Date()
    @State private var timezone = TimeZone.current.identifier
    @State private var capped = false
    @State private var maxPlayers = 16
    @State private var entryFee = "0"
    @State private var rated = true
    @State private var bestOf = 5
    @State private var qualifiers = 2
    @State private var rounds = 3
    @State private var saving = false
    @State private var error: String?
    // Only formats whose configuration this form understands. The server catalogue
    // remains the authority on which of these may actually be created.
    private var formats: [TournamentDTO.DrawType] {
        (tournament.drawTypeCatalogue ?? []).filter { ["round-robin", "single-elim", "rr-then-ko", "swiss"].contains($0.key) }
    }
    var body: some View {
        NavigationStack {
            Form {
                Section("Singles event") {
                    TextField("Event name", text: $name)
                    Picker("Draw", selection: $drawType) { ForEach(formats) { Text($0.name).tag($0.key) } }
                    if let format = formats.first(where: { $0.key == drawType }) { Text(format.description).font(.footnote).foregroundStyle(.secondary) }
                    if drawType == "rr-then-ko" { Stepper("Qualifiers per group: \(qualifiers)", value: $qualifiers, in: 1...8) }
                    if drawType == "swiss" { Stepper("Rounds: \(rounds)", value: $rounds, in: 1...20) }
                    Toggle("Limit players", isOn: $capped)
                    if capped { Stepper("Maximum players: \(maxPlayers)", value: $maxPlayers, in: 2...256) }
                    TextField("Entry fee", text: $entryFee).keyboardType(.decimalPad)
                }
                Section("Schedule") {
                    DatePicker("Date", selection: $date, displayedComponents: .date)
                    DatePicker("Start", selection: $start, displayedComponents: .hourAndMinute)
                    DatePicker("End", selection: $end, displayedComponents: .hourAndMinute)
                    Picker("Time zone", selection: $timezone) {
                        ForEach(TimeZone.knownTimeZoneIdentifiers, id: \.self) { Text($0).tag($0) }
                    }
                    Text("Start and end are local times in the selected event time zone.").font(.footnote)
                }
                Section("Match settings") {
                    Toggle("Rated matches", isOn: $rated)
                    Picker("Best of", selection: $bestOf) { ForEach([1, 3, 5, 7], id: \.self) { Text("\($0) games").tag($0) } }
                }
                if let error { Section { Text(error).foregroundStyle(FMColor.loss) } }
            }
            .navigationTitle("Add event").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(saving) }
                ToolbarItem(placement: .confirmationAction) { Button(saving ? "Saving…" : "Add") { save() }.disabled(!valid || saving) }
            }
            .task { if drawType.isEmpty { drawType = formats.first?.key ?? "" } }
            .interactiveDismissDisabled(saving)
        }.tint(FMColor.ball500).preferredColorScheme(.dark)
    }
    private var valid: Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && name.count <= 255 && !drawType.isEmpty &&
        (TournamentCopy.entryFee(entryFee).map { $0.isFinite && $0 >= 0 } ?? false) && formatted(start, "HH:mm") < formatted(end, "HH:mm")
    }
    private func formatted(_ date: Date, _ format: String) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = .current
        formatter.dateFormat = format
        return formatter.string(from: date)
    }
    private func save() {
        guard valid, !saving, let fee = TournamentCopy.entryFee(entryFee) else { return }
        saving = true
        let body = NewTournamentEventBody(
            name: name.trimmingCharacters(in: .whitespacesAndNewlines), drawType: drawType,
            qualifiersPerGroup: drawType == "rr-then-ko" ? qualifiers : nil,
            rounds: drawType == "swiss" ? rounds : nil, maxPlayers: capped ? maxPlayers : nil,
            entryFee: fee, timezone: timezone,
            slot: .init(date: formatted(date, "yyyy-MM-dd"), start: formatted(start, "HH:mm"), end: formatted(end, "HH:mm")),
            matchSettings: .init(rated: rated, lengthGames: bestOf)
        )
        Task {
            do { try await service.createEvent(tournament.id, body: body); onCreated() }
            catch { self.error = error.fmMessage }
            saving = false
        }
    }
}
