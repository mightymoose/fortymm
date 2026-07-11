# 15. Match-details extras load through a repository, and batch their per-user aggregates

Date: 2026-07-11

## Status

Accepted

## Context

`GET /v1/matches/{id}` — and the five score-write endpoints, which all return the
same `MatchDetails` payload — build a "view extras" block: rating changes, each
player's recent form (with their pre-match rating sparkline and career record),
and the head-to-head record.

Two problems had accumulated in `api/app/matches.py`:

1. **An N+1 in `_load_recent_form`** (issue #195). It looped over the match's
   users and issued three sequential `await db.execute(...)` calls *per user* —
   the recent-form rows, `_load_pre_match_rating`, and `_load_career_before`.
   For a singles match (N=2) that is 6 round-trips for this panel alone.

2. **The router was the de-facto shared query module.** ~270 lines of raw
   SQLAlchemy lived in a 2,324-line router, and `app/dashboard.py` imported
   seven helpers directly out of it — squarely against the `api/CLAUDE.md` rule
   that routers must not import each other's internals and that a handler should
   "call a service/query function, not contain raw SQLAlchemy queries".

## Decision

**Batch the per-user aggregates; do not parallelise with `asyncio.gather`.**

`_load_career_before` becomes a single `GROUP BY user_id` query and
`_load_pre_match_rating` a single `ROW_NUMBER() OVER (PARTITION BY user_id ORDER
BY created_at DESC)` window query, each covering every user in one round-trip.
The recent-form *rows* query stays inside the per-user loop.

**Move the extras behind the repository → domain → mapper seam** that
`MatchRepository` / `app/domain/match/models.py` / `app/mappers/` already
establish, rather than leaving raw SQL in the router. The shared helpers
(`participant_filter`, `my_side`, `opponent_username`, …) move out of the router
so nothing imports it any more.

**The response contract is frozen.** The extras keep serialising into the
existing `MatchDetails` Pydantic schemas; `openapi.json`, `schema.d.ts`, and
`Types.swift` are unchanged. This is an internal re-layering plus a query fix.

## Consequences

### Why not `asyncio.gather` over short-lived sessions

The issue floated a session-factory + `gather` approach. We rejected it:

- **It does not fix the stated problem.** It still issues 6 round-trips; it only
  overlaps them. The complaint in #195 is the round-trip *count*.
- **It multiplies pooled connections on the hottest endpoint.**
  `app/db.py` builds the engine with `create_async_engine(url, pool_pre_ping=True)`
  and no `pool_size`/`max_overflow`, so it runs on SQLAlchemy's defaults —
  **5 + 10 overflow = 15 connections per process**. `gather`-ing three loaders on
  their own sessions makes one in-flight request hold its own pooled connection
  *plus three more*. That is the pool-exhaustion failure mode of issue #641.
- **It is only accidentally safe.** It reads committed data today purely because
  all five score-write callers happen to `await db.commit()` *before* calling
  `_load_view_extras`. It becomes a silent footgun the moment anyone calls the
  extras mid-transaction — and there are six call sites.

Batching adds zero connections and is correct on any session in any transaction
state.

### Why the recent-form rows query stays per-user

Batching it (a window function for the top-N match ids, then one hydrating
`SELECT ... WHERE id IN (...)`) would take **2 queries to 2 queries** at N=2 — it
buys literally nothing. It only pays off for doubles, which cannot occur:
`result_acceptance.py` raises on `team_size != 1` (issue #183) and
`_singles_user_ids` skips any side without exactly one player. So the honest win
here is **6 round-trips → 4**, not 6 → 2.

### What "fixed" means, given we cannot measure it

There is no perf harness, and testcontainer Postgres makes any latency number
noise. So the acceptance criterion is deterministic, not temporal: **each batched
loader issues exactly one SQL statement regardless of how many user ids it is
given** (asserted with a 3-element list, so a reintroduced per-user loop fails
loudly), plus a blunt total-round-trip tripwire around the extras block. We are
explicitly *not* claiming a latency improvement.

### Accepted costs

- Batching turns "this user has no history" from a `(0, 0)` / `(None, [])` return
  into a **missing key** in the result dict. Both batched loaders must default
  explicitly; this is the specific regression the refactor risks, and it is
  covered by tests for a zero-history player.
- The write paths still recompute the extras on every score save even though all
  of them except `rating_changes` are strictly-pre-match history and cannot have
  changed. That is a real and larger inefficiency, tracked separately as
  **issue #911** — it is not fixed here.
