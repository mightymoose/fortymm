import Foundation

enum TournamentStatus: String, LenientRawDecodable, CaseIterable, Identifiable {
    case draft, published, live, archived, unknown
    var id: Self { self }
    var label: String {
        switch self {
        case .draft: "Draft"
        case .published: "Registration open"
        case .live: "Live"
        case .archived: "Completed"
        case .unknown: "Unavailable"
        }
    }
    var next: Self? {
        switch self {
        case .draft: .published
        case .published: .live
        case .live: .archived
        default: nil
        }
    }
    var action: String {
        switch self {
        case .draft: "Publish tournament"
        case .published: "Start tournament"
        case .live: "End tournament"
        default: ""
        }
    }
    var consequence: String {
        switch self {
        case .draft: "This makes the tournament visible and opens registration. It cannot return to draft."
        case .published: "This closes registration and starts play. Players can no longer enter or withdraw."
        case .live: "This ends the tournament. It cannot be restarted."
        default: ""
        }
    }
}

struct TournamentDTO: Decodable, Identifiable {
    let id: UUID
    let name: String
    let description: String?
    let status: TournamentStatus
    let canEdit: Bool
    let distanceMiles: Double?
    let createdByUsername: String
    let address: Address?
    let dateRange: DateRange?
    let tableCatalogue: [Table]
    let events: [TournamentEventDTO]
    let drawTypeCatalogue: [DrawType]?
    let latestScheduleSolve: ScheduleSolve?
    struct ScheduleSolve: Decodable {
        let status: String
        let fixturesPlaced: Int?
        let overrunning: Bool
        let error: String?
        var label: String {
            ["queued": "Schedule queued", "running": "Scheduling matches…", "succeeded": "Schedule ready", "infeasible": "Some matches cannot fit the schedule", "failed": "Scheduling failed"][status] ?? "Schedule status unavailable"
        }
    }
    var schedulePollSeconds: Int? {
        if let solve = latestScheduleSolve, ["queued", "running"].contains(solve.status) { return 3 }
        return status == .live ? 15 : nil
    }
    func drawName(_ event: TournamentEventDTO) -> String {
        drawTypeCatalogue?.first { $0.key == event.drawType }?.name ?? event.formatLabel
    }

    struct Address: Decodable {
        let venue, street, city, region, postal, country: String
        let latitude, longitude: Double?
        var label: String {
            let compact = [venue, city, region].filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }.joined(separator: ", ")
            if !compact.isEmpty { return compact }
            let fallback = [street, postal, country].filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }.joined(separator: ", ")
            return fallback.isEmpty ? "Venue to be announced" : fallback
        }
        var full: String { [venue, street, city, region, postal, country].filter { !$0.isEmpty }.joined(separator: ", ") }
    }
    struct DateRange: Decodable {
        let start, end: String
        var label: String { start == end ? TournamentCopy.date(start) : "\(TournamentCopy.date(start)) – \(TournamentCopy.date(end))" }
    }
    struct Table: Decodable, Identifiable {
        let id: String
        let label, court: String
    }
    struct DrawType: Decodable, Identifiable {
        let key, name, description: String
        var id: String { key }
    }
    var entryCount: Int { events.reduce(0) { $0 + $1.entrants.count } }
}

struct TournamentEventDTO: Decodable, Identifiable {
    let id: UUID
    let name, format, drawType, timezone: String
    let maxPlayers: Int?
    let matchSettings: MatchSettings?
    let predicates: [Predicate]?
    let reservations: [Reservation]?
    let qualifiersPerGroup: Int?
    let rounds: Int?
    struct MatchSettings: Decodable { let rated: Bool; let lengthGames: Int }
    struct Reservation: Decodable, Identifiable {
        let id: UUID
        let name: String
        let slot: Slot
        let tableIds: [String]
    }
    struct Predicate: Decodable, Identifiable {
        let id, op: String
        let value: Value?
        enum Value: Decodable {
            case number(Int), range([Int?])
            init(from decoder: Decoder) throws {
                let container = try decoder.singleValueContainer()
                if let number = try? container.decode(Int.self) { self = .number(number) }
                else { self = .range(try container.decode([Int?].self)) }
            }
        }
        var label: String {
            switch value {
            case .number(let value):
                let symbol = ["<": "<", "<=": "≤", ">": ">", ">=": "≥", "=": "=", "!=": "≠"][op] ?? op
                return "Rating \(symbol) \(value)"
            case .range(let values):
                return "Rating \(values.map { $0.map(String.init) ?? "—" }.joined(separator: "–"))"
            case nil: return "Rating restriction"
            }
        }
    }
    let entryFee: Double
    let slot: Slot
    let entrants: [Entrant]
    let entryState: EntryState
    let fixtures: [Fixture]
    let stages: [Stage]
    let groups: [Group]
    let results: Results?
    struct Slot: Codable {
        let date, start, end: String
        var dateLabel: String { TournamentCopy.date(date) }
    }
    struct Entrant: Decodable, Identifiable {
        let id, userId: UUID
        let username: String
        let seed: Int?
        let rating: Double?
    }
    struct EntryState: Decodable {
        let state: Kind
        let predicateId: String?
        let rating: Double?
        enum Kind: String, LenientRawDecodable {
            case open, full = "event_full", ineligible = "rating_ineligible", unknown
        }
    }
    struct Stage: Decodable, Identifiable { let id: UUID; let position: Int; let drawType: String }
    struct Group: Decodable, Identifiable { let id, stageId: UUID; let position: Int }
    struct Fixture: Decodable, Identifiable {
        let id, stageId, groupId: UUID
        let round, position: Int
        let entryAId, entryBId, winnerEntryId, matchId: UUID?
        let matchStatus: APIMatchStatus?
        let tableId: String?
        let scheduledStart, pinnedAt, completedAt: Time?
        let tableOffReservation, startOutsideReservationWindow: Bool?
        var statusLabel: String {
            if matchStatus == .voided { return "Voided" }
            if winnerEntryId != nil || matchStatus == .completed { return "Final" }
            if pinnedAt != nil { return "Called" }
            return scheduledStart == nil ? "Unscheduled" : "Estimated"
        }
        struct Time: Decodable {
            let instant: Date
            let localLabel, tzAbbrev: String
            var label: String { "\(localLabel) \(tzAbbrev)" }
        }
    }
    struct Results: Decodable {
        let kind: String
        let groups: [Standings]?
        let rows: [Standing]?
        let finishes: [Finish]?
        let champion: UUID?
        let complete: Bool
        struct Standings: Decodable, Identifiable {
            let groupId: UUID
            let rows: [Standing]
            var id: UUID { groupId }
        }
        struct Standing: Decodable, Identifiable {
            let entryId: UUID
            let rank, played, wins, losses, gamesWon, gamesLost: Int
            let buchholz: Int?
            var id: UUID { entryId }
        }
        struct Finish: Decodable, Identifiable {
            let entryId: UUID
            let position: Int
            var id: UUID { entryId }
        }
    }
    func fixtureHeading(_ fixture: Fixture) -> String {
        let round = "Round \(fixture.round)"
        guard stages.first(where: { $0.id == fixture.stageId })?.drawType == "round-robin" else { return round }
        return "\(round) · \(groupLabel(fixture.groupId))"
    }
    func canCutDraw(canEdit: Bool) -> Bool {
        canEdit && !fixtures.contains { $0.winnerEntryId != nil || $0.matchId != nil }
    }
    var formatLabel: String { drawType.replacingOccurrences(of: "-", with: " ").capitalized }
    var capacityLabel: String { maxPlayers.map { "\(entrants.count)/\($0) players" } ?? TournamentCopy.count(entrants.count, "player") }
    func player(_ id: UUID?) -> String {
        guard let id else { return "TBD" }
        return entrants.first { $0.id == id }?.username ?? "Withdrawn"
    }
    var ineligibilityMessage: String {
        let rule = predicates?.first { $0.id == entryState.predicateId }?.label ?? "Your rating does not meet this event’s eligibility rules"
        return entryState.rating.map { "\(rule). Your rating is \(Int($0.rounded()))." } ?? rule + "."
    }
    func groupLabel(_ id: UUID) -> String {
        guard let group = groups.first(where: { $0.id == id }) else { return "Group" }
        var index = max(0, group.position)
        var letters = ""
        repeat {
            letters = String(UnicodeScalar(65 + index % 26)!) + letters
            index = index / 26 - 1
        } while index >= 0
        return "Group \(letters)"
    }
}

/// Calendar-only API dates never pass through the device's time zone.
enum TournamentCopy {
    static func validName(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty && trimmed.unicodeScalars.count <= 255
    }
    static func validDescription(_ text: String) -> Bool {
        text.unicodeScalars.count <= 1024
    }
    static func entryFee(_ text: String, locale: Locale = .current) -> Double? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let scanner = Scanner(string: trimmed)
        scanner.locale = locale
        guard !trimmed.isEmpty, let value = scanner.scanDouble(), scanner.isAtEnd,
              value.isFinite, value >= 0, value <= 999_999.99,
              var decimal = Decimal(string: String(value), locale: Locale(identifier: "en_US_POSIX")) else { return nil }
        var cents = Decimal()
        NSDecimalRound(&cents, &decimal, 2, .down)
        guard decimal == cents else { return nil }
        return value
    }
    static func count(_ count: Int, _ noun: String, plural: String? = nil) -> String {
        "\(count) \(count == 1 ? noun : (plural ?? noun + "s"))"
    }
    static func date(_ value: String) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd"
        guard let date = formatter.date(from: value) else { return value }
        formatter.locale = .current
        formatter.dateStyle = .medium
        return formatter.string(from: date)
    }
}

struct TournamentNearMe: Equatable {
    let latitude, longitude: Double
    let radiusMiles: Int
    var query: [URLQueryItem] {
        [URLQueryItem(name: "lat", value: String(latitude)), URLQueryItem(name: "lng", value: String(longitude)), URLQueryItem(name: "radius_miles", value: String(radiusMiles))]
    }
}

/// Bounds shared with the tournament write schema in api/app/schemas/tournament.py.
enum TournamentEventLimits {
    static let players = 1...512
    static let rounds = 1...32
    static let qualifiers = 1...1000
}

/// Index entrants once, then assign each sorted fixture to its participating users.
struct TournamentPlayerSchedule {
    let players: [TournamentEventDTO.Entrant]
    let fixturesByUser: [UUID: [UUID]]

    init(events: [TournamentEventDTO], fixtureOrder: [UUID]) {
        var playersByUser: [UUID: TournamentEventDTO.Entrant] = [:]
        var usersByFixture: [UUID: Set<UUID>] = [:]
        for event in events {
            var userByEntry: [UUID: UUID] = [:]
            for entrant in event.entrants {
                userByEntry[entrant.id] = entrant.userId
                if playersByUser[entrant.userId] == nil { playersByUser[entrant.userId] = entrant }
            }
            for fixture in event.fixtures {
                usersByFixture[fixture.id] = Set([fixture.entryAId, fixture.entryBId].compactMap { entry in
                    entry.flatMap { userByEntry[$0] }
                })
            }
        }
        var grouped: [UUID: [UUID]] = [:]
        for fixtureId in fixtureOrder {
            for userId in usersByFixture[fixtureId] ?? [] {
                grouped[userId, default: []].append(fixtureId)
            }
        }
        players = playersByUser.values.sorted { $0.username.localizedStandardCompare($1.username) == .orderedAscending }
        fixturesByUser = grouped
    }
}
