import Combine
import Foundation

struct TournamentService {
    var client: APIClient = .shared
    func list(nearMe: TournamentNearMe? = nil) async throws -> [TournamentDTO] { try await client.get("/v1/tournaments", query: nearMe?.query ?? []) }
    func detail(_ id: UUID) async throws -> TournamentDTO { try await client.get("/v1/tournaments/\(id)") }
    func create(name: String, description: String) async throws -> UUID {
        struct Body: Encodable { let name, description: String }
        struct Created: Decodable { let id: UUID }
        let result: Created = try await client.post("/v1/tournaments", body: Body(name: name, description: description))
        return result.id
    }
    func enter(_ id: UUID, event: UUID) async throws {
        let _: TournamentEventDTO.Entrant = try await client.post("/v1/tournaments/\(id)/events/\(event)/entries")
    }
    func withdraw(_ id: UUID, event: UUID, entry: UUID) async throws {
        try await client.deleteWithoutResponse("/v1/tournaments/\(id)/events/\(event)/entries/\(entry)")
    }
    func transition(_ id: UUID, to: TournamentStatus) async throws {
        struct Body: Encodable { let to: String }
        struct Response: Decodable { let id: UUID }
        let _: Response = try await client.post("/v1/tournaments/\(id)/transitions", body: Body(to: to.rawValue))
    }
    func cutDraw(_ id: UUID, event: UUID) async throws {
        let _: [TournamentEventDTO.Fixture] = try await client.post("/v1/tournaments/\(id)/events/\(event)/draw")
    }
    func createEvent(_ id: UUID, body: NewTournamentEventBody) async throws {
        let _: TournamentEventDTO = try await client.post("/v1/tournaments/\(id)/events", body: body)
    }
}

struct NewTournamentEventBody: Encodable {
    let name: String
    let format = "singles"
    let drawType: String
    let qualifiersPerGroup: Int?
    let rounds: Int?
    let maxPlayers: Int?
    let entryFee: Double
    let timezone: String
    let slot: TournamentEventDTO.Slot
    let matchSettings: MatchSettings
    struct MatchSettings: Encodable { let rated: Bool; let lengthGames: Int }
}

/// Refresh in place; a newer request always supersedes the old one.
@MainActor
final class TournamentStore<Value>: ObservableObject {
    enum State { case idle, loading, loaded(Value), failed(String) }
    @Published private(set) var state: State = .idle
    @Published private(set) var refreshError: String?
    private let fetch: () async throws -> Value
    private var inFlight: Task<Void, Never>?
    init(fetch: @escaping () async throws -> Value) { self.fetch = fetch }
    var value: Value? { if case let .loaded(value) = state { value } else { nil } }
    func load(force: Bool = false, preservingContent: Bool = true) async {
        if !force {
            if value != nil { return }
            if case .loading = state { return }
        }
        let hasContent = preservingContent && value != nil
        if !hasContent { state = .loading }
        inFlight?.cancel()
        let task = Task {
            do {
                let value = try await fetch()
                guard !Task.isCancelled else { return }
                state = .loaded(value)
                refreshError = nil
            } catch {
                guard !Task.isCancelled else { return }
                if hasContent { refreshError = error.fmMessage }
                else { state = .failed(error.fmMessage) }
            }
        }
        inFlight = task
        await task.value
        if inFlight == task { inFlight = nil }
    }
}
