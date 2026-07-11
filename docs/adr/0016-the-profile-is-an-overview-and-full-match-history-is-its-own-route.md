# The profile is an overview; full match history moves to its own route

The player profile *was* the full match history: a 25-per-page table with
URL-driven `?page=`, a no-flash `keepPreviousData` transition, and an
out-of-range snap-back (#637). The redesign makes the profile an overview — a
hero, a rating chart, career, confidence, leagues, head-to-head — with the match
table reduced to a **Recent matches** card showing the last six and a "View all N
matches" link.

The full, paginated, perspective-flipped list moves to **`/players/$userId/matches`**,
backed by the `GET /v1/players/{id}/matches` endpoint it already used.

**This does not overturn ADR-0008.** That ADR says the profile's match list is
*unfiltered* — every match the player is a side of, any status, rated or not,
including the "No opponent" solo row — and warns against narrowing it to
rated-only. Both the recent-six window and the sub-route it links to remain fully
inclusive. "Full history" there means unfiltered, not unpaginated.

## Considered options

- **A dedicated sub-route (chosen).** Preserves every contract we have: the
  perspective flip, the awaiting-acceptance flag, the solo sentinel, the
  pagination, the snap-back, and the tests for all of them. The existing table,
  footer and route tests move across roughly intact. It is the only option where
  "View all" actually means *all*.
- **Point "View all" at `/matches?q=<username>`.** Rejected. It looks free — the
  dashboard's "Full history" link already does this — but `GET /v1/matches` is a
  *global* list narrowed by a text search. Its rows are not flipped to the
  player's perspective (no "my score" vs "theirs", no W/L from *their* point of
  view), and a username substring match is not the same population as "matches
  this user is a side of". It would silently downgrade the contract and strand
  `usePlayerMatches`.
- **Expand the table in place.** Rejected: the profile would go back to being an
  overview *and* a table, which is the thing the redesign exists to stop.
- **Keep the profile paginated and drop the overview cards.** Rejected — that is
  simply declining the redesign.

## Consequences

`?page=` disappears from the profile's search schema and reappears on the
sub-route. A stale bookmark of `/players/x?page=3` degrades harmlessly (the
schema `.catch()`es it) rather than 404ing.

Two match totals now appear on one page and they are *different numbers*, on
purpose. Career says "47 decided" — the denominator of the win rate, completed
matches only. The link says "View all 50 matches" — the all-inclusive history of
ADR-0008, which also counts the three matches currently in play. Anyone who
"fixes" these to agree has reintroduced the bug.

The recent-six window is a window onto the inclusive list, so it renders live,
up-next, awaiting-acceptance, voided and solo rows too. It has no result-chip
column, so that state is carried by the row's status dot and by the score cell
(which reads "Live" / "Awaiting" / "—" where a score would go). A rating delta is
`—`, never `+0`, for anything undecided or unrated.
