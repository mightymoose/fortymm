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

### Why the recent-form rows query stays per-user — and why that reasoning was wrong

The original argument was: batching it (a window function for the top-N match ids,
then one hydrating `SELECT ... WHERE id IN (...)`) takes **2 queries to 2 queries**
at N=2, so it buys nothing; it would only pay off for doubles, which cannot occur
(`result_acceptance.py` raises on `team_size != 1`, issue #183).

**That arithmetic was wrong, and it was never measured.** The recent-form rows
query is `history_base_query(...)`, which attaches `match_history_options()` — a
`selectinload` chain (`sides → players → user`, `games → score`). So each per-user
execute fans out into **6 round-trips, not 1**. Counted against a completed singles
match *with prior history* (an empty-history fixture hides this, because the eager
chains have no rows to fan out over), the whole extras block is:

```
 1  rating_changes
 1  career_before        (batched here)
 1  pre_match_ratings    (batched here)
 6  player 1 recent-form rows + its selectinload fan-out
 6  player 2 recent-form rows + its selectinload fan-out
 7  head-to-head rows + its fan-out
 1  head-to-head counts
---
23  total
```

So the per-user term is `6 × N`, and batching it is worth roughly **12 → 6** —
about three times what this ADR's decision actually saved. It is the *dominant*
term, and it was YAGNI'd on an unchecked number.

We are still not doing it here (this change is already three slices deep, and the
right response to having been wrong about a query's cost is a measured follow-up,
not a same-day scope expansion). It is filed as **issue #920** with the breakdown
above. What this ADR actually delivers is **25 → 23** statements, plus two loaders
that are now O(1) in player count instead of O(N), plus the guard.

### What "fixed" means, given we cannot measure it

There is no perf harness, and testcontainer Postgres makes any latency number
noise. So the acceptance criterion is deterministic, not temporal: **each batched
loader issues exactly one SQL statement regardless of how many user ids it is
given** (asserted with a 3-element list, so a reintroduced per-user loop fails
loudly), plus a blunt total-round-trip tripwire around the extras block. We are
explicitly *not* claiming a latency improvement.

The tripwire is pinned against a fixture that **has prior history**. This matters:
an empty-history fixture makes the `selectinload` chains emit nothing, so it counts
7 statements where a real match costs 23 — it would flatter the change and, worse,
would not notice an eager-load fan-out regression at all. Pin the realistic case.

### A batched query is not automatically a cheaper query

Batching `pre_match_ratings` with `ROW_NUMBER() OVER (PARTITION BY user_id ...)`
collapsed N round-trips into one — and silently **threw away the per-user `LIMIT`
pushdown**. Postgres cannot stop an index scan early across window partitions (the
`Run Condition: row_number() <= 10` doesn't terminate it), so the query read every
one of a player's in-league rating rows and sorted them just to return 10. Measured
on a 120k-row `rating_history`: 600 rows scanned / 614 buffers, versus 20 rows / 26
buffers for the per-user query it replaced — and **unbounded in career length** (a
player with 3000 rating rows sorted 3300). No index fixes it; the over-scan is
inherent to the shape.

The loader therefore uses a `LATERAL` join with the `LIMIT` *inside* — one round-trip
**and** the pushdown. `career_before` has no such hazard precisely because it has no
per-user `LIMIT` to lose: it aggregates the whole career either way, so its `GROUP BY`
scans exactly what the per-user queries scanned, minus the round-trips. The rule:
**`LIMIT` present → a window batch can regress; no `LIMIT` → the `GROUP BY` is free.**

### Accepted costs

- Batching turns "this user has no history" from a `(0, 0)` / `(None, [])` return
  into a **missing key** in the result dict. Both batched loaders must default
  explicitly; this is the specific regression the refactor risks, and it is
  covered by tests for a zero-history player.
- The write paths still recompute the extras on every score save even though all
  of them except `rating_changes` are strictly-pre-match history and cannot have
  changed. That is a real and larger inefficiency, tracked separately as
  **issue #911** — it is not fixed here.
