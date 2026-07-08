# The player-profile Matches section is a full match history, not a rated-play record

The per-player matches endpoint (`_paginated_player_matches` in `api/app/players.py`)
filters on participation alone — every match the player is on a side of, any status,
rated or not, opponent or solo. The profile's Matches section renders exactly that,
including the deliberate "No opponent" row for solo matches. We treat this all-inclusive
list as the intended contract and fixed the empty-state copy that contradicted it
(it read "hasn't played any *rated* matches"; issue #845).

The crux: a player's **rating** is rated-only, but their **match history** is
all-inclusive. Copy and code must not conflate the two.

## Considered options

- **Broaden the copy to match the list (chosen).** The list's breadth is intentional —
  the row renderer has first-class handling for solo/unrated/in-progress matches, and
  the hero already labels a rating-less player "Unrated" separately. The stray word
  "rated" in the empty state was the only thing out of step, so we removed it. Minimal,
  and it keeps working behavior.
- **Narrow the list to match the copy — filter to rated matches.** Rejected: it would
  delete intended, tested behavior (the "No opponent" solo row, unrated friendlies,
  in-progress matches) to satisfy one adjective, and it would make the Matches section
  a second rated-only surface redundant with the rating hero.
- **Add explicit sub-scopes (All / Rated tabs).** Rejected as over-engineering for a P4
  copy bug; no product need for a rated-only filter on the profile exists today.

## Consequences

The next person who sees the rating-flavored hero next to an all-inclusive list should
not "fix" the list back down to rated-only — that reconciliation was considered and
rejected here. If a rated-only view is ever wanted, it is a new scoped surface, not a
narrowing of Match history.
