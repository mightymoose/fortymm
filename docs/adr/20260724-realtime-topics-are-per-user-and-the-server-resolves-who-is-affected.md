# Realtime topics are per-user, and the server resolves who is affected

A realtime stream needs a subscription model. The obvious one is resource-scoped:
the client says "I am looking at tournament X" and subscribes to `tournament:X`.

We rejected that. **The only topic is `user:<user_id>`, it is implicit, and a client
cannot request anything else.** `GET /v1/stream` takes no parameters. When a write
happens, the *server* works out which users' dashboards changed and publishes to each
of them.

## Why

**It matches what the dashboard already is.** Both panels are already
participant-scoped: `build_tournament_panels(db, user_id)` returns "every live
tournament the caller holds an active entry in", and attention is ranked per
current-user. A resource-scoped topic would have let a client subscribe to a
tournament it is merely *allowed to view* and receive traffic about a panel it will
never be shown.

**It deletes the entire stream-side authorization problem.** With a
`tournament:<id>` topic, `/v1/stream` would have to re-implement both gates that
`GET /v1/tournaments/{id}` enforces — the `tournament.view` permission **and** the
`visible_to` predicate, including its load-bearing 404-not-403 behavior, which exists
so an unannounced tournament's existence is not confirmed. That is a second copy of a
rule whose own docstring warns that two copies "would eventually disagree — and the
way they disagree is that one hides a draft another still serves."

With per-user topics there is nothing to authorize: you receive your own topic or
nothing. No permission check, no visibility predicate, no 403/404 distinction, no
per-topic limit.

**It removes mid-stream revocation as a security concern.** A resource-scoped stream
authorizes once at connect, so revoking a permission mid-stream leaves the connection
emitting for a resource the caller can no longer read. That forced either a
per-event re-authorization round trip or a short forced stream lifetime as a
containment knob. Neither is needed when the only topic a user can ever receive is
their own.

**It simplifies both clients out of proportion to the server cost.** No topic
registry, no ref-counting, no `useRealtimeTopic`, no debounced reconnect when the
subscription set changes, no reconnect-on-navigation. The connection URL is constant
for the life of the session, so the web client opens exactly one stream at the
authenticated route boundary and never reopens it on navigation.

## The fan-out rule

Each write resolves its own affected set. Every one of these is already reachable
from data the write path holds:

| write | affected users |
| --- | --- |
| result proposed / accepted, match completed | the two participants |
| per-game score entered, edited, deleted | the two participants |
| match call issued / moved / cancelled | the called players (the fan-out job already carries their ids) |
| tournament goes live | active entrants (this is when the panel *appears*) |
| draw advances, schedule re-solved | active entrants of the affected event |

## Consequences

**Fan-out cost is O(affected users) publishes per write**, not O(1). A draw advance
in a 32-entrant event is 32 Redis `PUBLISH` calls. This is fine — `PUBLISH` is
sub-millisecond and fire-and-forget — but it is a real difference from a
resource-topic design, where one publish serves every subscriber. If an event ever
needs to reach hundreds of users at once, revisit this.

**Resolving the affected set is now write-path work**, and getting it wrong is
silent: too narrow and someone's dashboard stays stale, too wide and we send
pointless refetches. The set-resolution for each site deserves a test that names the
users who should and should not be hinted.

**A spectator surface would need a new decision.** Nothing here extends to "watch a
tournament you are not in." That is deliberate — it was explicitly out of scope — but
it means a future spectator view cannot simply reuse this stream; it would reopen the
resource-topic question and all the authorization work above.
