# A rating block names its unrated state, and shows rank below the percentile threshold

Date: 2026-07-25

## Status

Accepted

Numbered by date, following the `20260724-*` ADR, not by incrementing the highest
file on disk — parallel worktrees each number off a stale main (see the ADR
README).

## Context

Two QA-filed bugs against the #915 rating rollout (#956, #959) turn on the same
root cause: the dashboard's rating block collapses distinct facts into a single
signal, and then says something false about the collapsed result.

**`null` conflates three states (#956).** `DashboardRating` is `| None`, and
`_build_rating()` (`dashboard.py`) has three `return None` exits that the client
cannot tell apart:

1. the player is **unrated in a glicko2 league** — in a rated league, but has not
   finished a rated match yet (the real state #915 introduced),
2. the player is in a **manual-strategy league awaiting an import**,
3. the player is **not in a rated league at all**.

The client renders one hardcoded string for all three — *"Not in a rated league
yet."* — which is a lie for state 1: that player *is* in a rated league. No single
string is true for all three, and the wire carries no way to distinguish them.

**Percentile lies at the bottom of a small ladder (#959).** `league_percentile`
returns `max(1, round(at_or_above / total * 100))`. For the lowest-rated player,
`at_or_above == total`, so the card reads **"Top 100% in FortyMM"** — literally
true, reads like a compliment, and is the one percentile value that should never
be shown. The profile already gates percentile behind
`PERCENTILE_MIN_RATED_PLAYERS` (50, provisional); the dashboard had no such gate,
which is how "Top 100%" surfaced. And below that threshold — a twelve-player alpha
— "Top 8% of 12" is not a statistic, it is "you are first" in a costume.

## Decision

**The rating block always returns an object carrying a `state` discriminator; the
client says the true thing per state.** `_build_rating()` no longer returns bare
`null` for the unrated/awaiting cases. It returns a `DashboardRating` whose `state`
is one of:

- `RATED` — has a rating; carries the rating value, delta, and the rank-or-percentile line below.
- `UNRATED` — in a glicko2 league, no rated match finished yet. Copy: *"Unrated — finish a rated match to start your rating."*
- `AWAITING_IMPORT` — manual-strategy league, import pending. Copy: *"Ratings haven't been imported for this league yet."*
- `NOT_RATED_LEAGUE` — not in a rated league at all. Copy: *"Not in a rated league yet."* (the existing string, now shown only when it is true).

The enum is server-authoritative — it is the API that knows which of the three
non-rated situations obtains, so it names it rather than leaving the client to
guess from a `null`.

**Below the percentile threshold, both surfaces show rank, not percentile.** When
the rated population is below `PERCENTILE_MIN_RATED_PLAYERS`, the dashboard *and*
the profile render **rank — "#N of M"** — instead of a percentile. At or above the
threshold, they render the percentile. Rank is honest at any position and any
league size ("#5 of 5" is not a compliment or an insult, it is a fact), and it
keeps a meaningful signal on screen during the alpha instead of blanking the card.
This unifies the two surfaces, which previously disagreed: the profile suppressed
the percentile below threshold (showing nothing), the dashboard showed it anyway
(showing "Top 100%").

The threshold constant stays **50** — #915 marked the number provisional and this
decision does not add evidence to move it. What changes is that below-threshold is
no longer "show nothing" but "show rank", and the switch is driven by the one
constant on both surfaces.

## Considered options

- **Keep returning `null`, add a sibling `reason` field.** Rejected: a nullable
  block with an out-of-band reason is exactly the shape that let the three states
  drift apart. A discriminated object keeps the state and its payload together, and
  parses as one thing at the boundary.
- **Suppress the percentile only at the bottom of the ladder (#959 option).**
  Rejected as a targeted hack: it fixes "Top 100%" but leaves "Top 8% of 12" — a
  meaningless-but-not-wrong statistic — on everyone else in a small league.
- **Just apply the profile's min-population gate to the dashboard.** Rejected as
  half a fix: it unifies the two surfaces but blanks the rating card's ranking line
  entirely during the whole alpha, where rank would have been useful and honest.

## Consequences

- `DashboardRating` is no longer nullable at the parent for the unrated/awaiting
  cases — a `state` discriminator replaces the `| None`. The OpenAPI regen carries
  the enum to `schema.d.ts` and `Types.swift`; the client renders copy per state.
- The rank-vs-percentile switch is a single threshold read shared by
  `dashboard.py` and the profile's `player_standing`; a future change to the
  provisional 50 moves both surfaces at once.
- `PERCENTILE_MIN_RATED_PLAYERS` remains provisional. Rank below it is the honest
  default until a real threshold is chosen; that choice is still open and out of
  scope here.
