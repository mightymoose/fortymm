import Foundation

private struct TestKeychain: SessionKeychain {
    let service = "tournament-tests"
    let account = UUID().uuidString
    func save(_ value: String) -> Bool { true }
    func load() -> String? { nil }
    func delete() {}
}

private final class TournamentTransport: URLProtocol {
    static var status = 200
    static var body = ""
    static var request: URLRequest?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.request = request
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: Self.status, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(Self.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@main struct TournamentTests {
    @MainActor static func main() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [TournamentTransport.self]
        let client = APIClient(session: URLSession(configuration: configuration), tokens: SessionTokenStore(keychain: TestKeychain()))
        let service = TournamentService(client: client)
        TournamentTransport.body = #"""
        [{"id":"00000000-0000-0000-0000-000000000001","name":"Open","description":null,"status":"published","can_edit":false,"created_by_username":"director","address":null,"date_range":null,"table_catalogue":[],"draw_type_catalogue":null,"events":[{"id":"00000000-0000-0000-0000-000000000002","name":"Singles","format":"singles","draw_type":"swiss","timezone":"America/Chicago","max_players":null,"entry_fee":0,"slot":{"date":"2026-09-05","start":"09:00","end":"17:00"},"entrants":[{"id":"00000000-0000-0000-0000-000000000003","user_id":"00000000-0000-0000-0000-000000000004","username":"alex","seed":null,"rating":null}],"entry_state":{"state":"open"},"stages":[{"id":"00000000-0000-0000-0000-000000000005","position":0,"draw_type":"swiss"}],"groups":[{"id":"00000000-0000-0000-0000-000000000006","stage_id":"00000000-0000-0000-0000-000000000005","position":0}],"fixtures":[{"id":"00000000-0000-0000-0000-000000000007","stage_id":"00000000-0000-0000-0000-000000000005","group_id":"00000000-0000-0000-0000-000000000006","round":1,"position":0,"entry_a_id":"00000000-0000-0000-0000-000000000003","entry_b_id":null,"winner_entry_id":null,"match_id":null,"match_status":null,"table_id":null,"scheduled_start":{"instant":"2026-09-05T14:00:00Z","local_label":"9:00 AM","tz_abbrev":"CDT"},"pinned_at":null}],"results":{"kind":"swiss_standings","rows":[{"entry_id":"00000000-0000-0000-0000-000000000003","rank":1,"played":0,"wins":0,"losses":0,"games_won":0,"games_lost":0}],"complete":false,"champion":null}}]}]
        """#
        var payload = try JSONSerialization.jsonObject(with: Data(TournamentTransport.body.utf8)) as! [[String: Any]]
        var eventPayload = (payload[0]["events"] as! [[String: Any]])[0]
        eventPayload["match_settings"] = ["rated": true, "length_games": 5]
        eventPayload["predicates"] = [["id": "rating-limit", "field": "rating", "op": "<=", "value": 1500]]
        eventPayload["reservations"] = [["id": "00000000-0000-0000-0000-000000000008", "name": "Morning", "slot": ["date": "2026-09-05", "start": "09:00", "end": "12:00"], "table_ids": ["table-1"]]]
        var results = eventPayload["results"] as! [String: Any]
        var rows = results["rows"] as! [[String: Any]]
        rows[0]["buchholz"] = 4
        results["rows"] = rows
        eventPayload["results"] = results
        payload[0]["events"] = [eventPayload]
        payload[0]["distance_miles"] = 12.5
        TournamentTransport.body = String(data: try JSONSerialization.data(withJSONObject: payload), encoding: .utf8)!
        let tournaments = try await service.list(nearMe: TournamentNearMe(latitude: 41.8, longitude: -87.6, radiusMiles: 50))
        let query = URLComponents(url: TournamentTransport.request!.url!, resolvingAgainstBaseURL: false)!.queryItems!
        precondition(query.first { $0.name == "lat" }?.value == "41.8")
        precondition(query.first { $0.name == "radius_miles" }?.value == "50")
        precondition(tournaments[0].distanceMiles == 12.5)
        precondition(tournaments[0].events[0].predicates?.first?.label == "Rating ≤ 1500")
        precondition(tournaments[0].events[0].reservations?.first?.tableIds == ["table-1"])
        precondition(tournaments[0].events[0].matchSettings?.lengthGames == 5)
        precondition(tournaments[0].events[0].results?.rows?.first?.buchholz == 4)
        precondition(tournaments[0].events[0].player(UUID()) == "Withdrawn")
        precondition(tournaments[0].schedulePollSeconds == nil)
        print("PASS: near-me query, distances, eligibility rules, reservations, match settings and Swiss tiebreaks")
        let event = tournaments[0].events[0]
        var reviewFailures: [String] = []
        if !event.canCutDraw(status: .published, canEdit: true) { reviewFailures.append("existing published draw cannot be re-cut") }
        if TournamentCopy.entryFee("12,50", locale: Locale(identifier: "de_DE")) != 12.5 { reviewFailures.append("comma-decimal fee refused") }
        let streetOnly = TournamentDTO.Address(venue: "", street: "123 Test Street", city: "", region: "", postal: "", country: "", latitude: nil, longitude: nil)
        if streetOnly.label != "123 Test Street" { reviewFailures.append("street-only venue has a blank label") }
        for failure in reviewFailures { print("FAIL: \(failure)") }
        precondition(reviewFailures.isEmpty, "Review regression checks failed")
        precondition(!event.canCutDraw(status: .live, canEdit: true))
        precondition(!event.canCutDraw(status: .published, canEdit: false))
        precondition(TournamentCopy.entryFee("12.50", locale: Locale(identifier: "en_US")) == 12.5)
        precondition(TournamentCopy.entryFee("12,50oops", locale: Locale(identifier: "de_DE")) == nil)
        print("PASS: re-cut visibility, localized entry fees, and partial venue labels")
        precondition(tournaments[0].address == nil && tournaments[0].entryCount == 1)
        precondition(event.capacityLabel == "1 player" && event.entrants[0].rating == nil)
        precondition(event.player(event.fixtures[0].entryAId) == "alex" && event.player(nil) == "TBD")
        precondition(event.groupLabel(event.groups[0].id) == "Group A")
        precondition(event.fixtures[0].scheduledStart?.label == "9:00 AM CDT")
        precondition(event.results?.rows?.first?.rank == 1)
        print("PASS: aggregate decoding, nullable fields, fixture joins, venue time labels, Swiss standings")

        let originalBody = TournamentTransport.body
        payload[0]["status"] = "live"
        TournamentTransport.body = String(data: try JSONSerialization.data(withJSONObject: payload), encoding: .utf8)!
        let live = try await service.list()
        precondition(live[0].schedulePollSeconds == 15)
        precondition(URLComponents(url: TournamentTransport.request!.url!, resolvingAgainstBaseURL: false)!.queryItems == nil)
        payload[0]["latest_schedule_solve"] = ["status": "running", "overrunning": false]
        TournamentTransport.body = String(data: try JSONSerialization.data(withJSONObject: payload), encoding: .utf8)!
        let solving = try await service.list()
        precondition(solving[0].schedulePollSeconds == 3)
        TournamentTransport.body = originalBody
        print("PASS: live schedule cadence, in-flight solve cadence, and clearing distance query")

        TournamentTransport.body = TournamentTransport.body.replacingOccurrences(of: "published", with: "future_status").replacingOccurrences(of: "\"state\":\"open\"", with: "\"state\":\"future_rule\"")
        let future = try await service.list()
        precondition(future[0].status == .unknown && future[0].events[0].entryState.state == .unknown)
        precondition(TournamentStatus.archived.next == nil && TournamentStatus.unknown.next == nil)
        print("PASS: unknown statuses and entry states degrade safely")

        TournamentTransport.status = 204
        TournamentTransport.body = ""
        try await service.withdraw(tournaments[0].id, event: event.id, entry: event.entrants[0].id)
        precondition(TournamentTransport.request?.httpMethod == "DELETE")
        precondition(TournamentTransport.request?.url?.path.hasSuffix("/entries/\(event.entrants[0].id)") == true)
        print("PASS: withdrawal uses entry ID and accepts an empty 204 response")

        TournamentTransport.status = 409
        TournamentTransport.body = #"{"detail":{"code":"event_full","message":"This event is full."}}"#
        do { try await service.enter(tournaments[0].id, event: event.id); preconditionFailure("Expected refusal") }
        catch { precondition(error.fmMessage == "This event is full.") }
        print("PASS: server entry refusals retain their actionable message")

        var shouldFail = false
        let store = TournamentStore<Int>(fetch: {
            if shouldFail { throw APIError.http(status: 503, detail: "Try again later") }
            return 42
        })
        await store.load()
        shouldFail = true
        await store.load(force: true)
        precondition(store.value == 42 && store.refreshError == "Try again later")
        print("PASS: refresh failure preserves loaded content and reports the failure")
        await store.load(force: true, preservingContent: false)
        precondition(store.value == nil, "A failed filter change must not show results for the previous filter")
        print("PASS: a new location filter cannot keep mismatched stale results")
    }
}
