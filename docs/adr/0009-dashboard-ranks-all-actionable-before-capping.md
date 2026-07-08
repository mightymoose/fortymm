# The dashboard ranks all actionable matches before capping (#838)

The "Needs your attention" panel eager-loaded open matches with
`ORDER BY updated_at ASC LIMIT 10` and *then* ranked those 10 by attention
priority. The cap was applied on an axis (`updated_at`) unrelated to priority,
so with more than 10 actionable matches the highest-priority row (a `review`
whose `updated_at` was freshly bumped when the opponent proposed) could be
dropped at the database before ranking ever saw it — the panel showed stale
`score` rows while the single most-urgent item was invisible. The `+N more`
footer stayed correct (it rides a separate exact COUNT), so the total was right
but the surfaced top rows were not the top-by-priority. The list Attention tab
(`matches.py`) never had this bug: it loads **all** actionable rows, ranks in
Python, then paginates.

We fixed the dashboard to do the same: load **every** actionable match via the
list tab's own `_attention_matches_query`, rank with the shared `app.attention`
classifier, then slice `[:ATTENTION_BANNERS_LIMIT]` for display. This unifies
the panel and the list on one definition of *who is actionable* and *in what
order* — the whole point of the shared `app.attention` module. `attention_total_count`
is now `len(loaded_rows)` (the list tab's "its length *is* the count" trick), so
the attention half of the old two-column COUNT aggregate is dropped; only the
`waiting_count` scan remains (waiting matches are never loaded).

## Considered options

- **Rank in Python over all actionable, cap after (chosen).** Reuses the exact
  ranking and membership the list tab already uses; one source of truth.
- **Encode attention priority in SQL, keep the `LIMIT 10`.** Rejected: it forces
  re-expressing `review`-vs-`score`-vs-rated priority in SQL (checking the
  result-chain head for an opponent-submitted standing proposal), duplicating
  the Python classifier and reintroducing exactly the drift `app.attention`
  exists to prevent.

## Consequence

This **reverses the hot-path optimization #216 introduced deliberately.** The
dashboard panel loads on essentially every homepage view, which is *why* #216
capped its eager-load; the list Attention tab is opt-in (loads on click), so
"the tab already loads it unbounded" does **not** transfer as reassurance — we
are accepting a heavier load on the hotter path. The dashboard now fully
eager-loads (sides, players, games, scores) every actionable match to rank them.

We accept this because ranking correctness beats the load in the common case,
but the cost is real at the tail: in variant-D round-robin (back-to-back
concurrent matches), a player can hold **dozens** of in-progress unscored
matches, all `score`-actionable — the actionable subset *is* the "dozens" case
#216 named, not always a handful. `ATTENTION_BANNERS_LIMIT` keeps its name and
value (10) but now caps the *ranked display list*, not the DB read.

**Escape hatch if the full eager-load ever bites (do not revert to
cap-then-rank).** Ranking needs *less* data than display: classification only
needs each match's result-chain head + sides (to bucket `review` vs `score` and
read `affects_rating`), while the full game/score hydration is only needed for
the top-K rows actually returned. The forward fix is therefore **load light to
rank, then hydrate the top-K** — never re-cap on `updated_at` before ranking,
which is the #838 bug. We chose the simple full-load now because the common case
is cheap and the two-phase load adds complexity we don't yet need.
