# The dashboard is kept fresh by pushed invalidation hints, not payloads

The dashboard was the one surface with **no freshness mechanism at all**: no poll,
no push, `staleTime: 30_000` and `refetchOnWindowFocus: false`. Sit on `/dashboard`
while your opponent posts a result and the "needs your attention" row stays until you
navigate away and back. iOS was the same, deliberately — see
`0010-ios-freshness-is-navigation-driven-not-realtime.md`, which named the
cross-platform realtime effort this ADR belongs to and left the gap open on purpose.

We decided the server pushes a **hint that something changed**, and the client
refetches the endpoint it already reads. The stream never carries domain data.

```
retry: 5312

data: {"v":1,"kind":"dashboard.changed","ts":"2026-07-24T18:02:11Z"}
```

The transport is Server-Sent Events on a single per-user `GET /v1/stream`, fanned
out between processes over Redis pub/sub.

## Why hints and not deltas

- **Authorization stays on the read path.** The hint names no resource and leaks no
  state, so the stream needs no authorization model of its own. The client's refetch
  of `GET /v1/dashboard` hits the same `get_current_user` gate it always did. A
  delta, by contrast, would need every rule the read endpoint enforces re-implemented
  on the write side.
- **No second serializer to drift.** `DashboardResponse` is a BFF payload composed
  from attention ranking, rating stats and `build_tournament_panels`. A delta over it
  would be a parallel projection that must never disagree with the real one — and the
  way it would disagree is by showing a player a stale standing or a cleared row that
  isn't.
- **Reconnects are self-healing.** Because a hint is idempotent and carries no
  sequence, a client that misses events while disconnected needs no replay log and no
  cursor: it just refetches on reconnect. The server emits `resync` on connect to make
  that explicit.

## Why SSE

- **`EventSource`/`bytes(for:)` semantics fit a one-way invalidation feed.** The
  client never sends anything; every write is an existing `/v1` route already under
  CSRF protection.
- **It is native in FastAPI 0.136.1** (`fastapi.sse.EventSourceResponse`), which
  supplies the 15s keepalive and sets `X-Accel-Buffering: no` and
  `Cache-Control: no-cache` for us. No new dependency.
- **WebSocket** buys bidirectionality we have no use for and costs `Upgrade` handling
  in three nginx configs, hand-rolled ping/pong and reconnect on both clients, no
  `retry:` field, and an `Origin` check the CSRF middleware does not cover for WS
  handshakes.
- **A cheap `updated_at` watermark poll** was the serious alternative and loses on
  this schema: dashboard attention is derived across `matches`, `match_results`,
  `match_sides` and `tournament_fixtures`, so there is no single watermark row without
  a new denormalized column bumped on every mutation — which is the fan-out we would
  be trying to avoid.

## Consequences

**Hints invert the load.** One event becomes one refetch per connected participant.
That is acceptable here only because the fan-out is participant-scoped (see
`20260724-realtime-topics-are-per-user-and-the-server-resolves-who-is-affected.md`)
and because each connection **coalesces** pending hints over a 250ms window before
emitting. Coalescing is lossless precisely because hints are idempotent — collapsing
N into 1 loses nothing. That is what keeps a burst of tournament completions from
becoming a refetch storm.

**Publishing must happen after commit, or it races the reader into stale data.** The
natural funnels (`finalize_match`, `on_match_completed`) explicitly do *not* commit —
they run in the caller's transaction. So hints are staged on the session
(`stage_event`) and flushed by a SQLAlchemy `after_commit` listener, and discarded on
`after_soft_rollback`. This makes "post-commit" mechanical rather than a code-review
property repeated across nine call sites.

**The stream holds no database connection.** A `Depends(get_session)` on a streaming
route would pin a connection for the life of the stream; with the engine's default
pool (15 per pod) roughly fifteen open tabs would exhaust it and every other request
on that pod would start taking the 503 path. Auth runs on a short-lived session that
closes before the first frame.

**What this deliberately does not do:** it does not make the tournament detail page,
the match detail page, the notification bell, or any spectator view live. Those keep
their existing polling. This ADR is scoped to the dashboard's two panels — Needs
Attention and the Tournament Panel — for the players who can act on them.
