# Roster rank is a global rating fact, not a page index

The `/players` roster shows a **Seed** column with the top four styled gold
(`players-seed--top`, the `--ball-500` top-seed accent). The number was computed
purely on the client as `startIndex + i + 1` — the row's position on the current
page. The server keeps a rating-descending sort, so on the *unfiltered first
page* that index coincidentally equals rating rank, and the column looked right.

The coincidence is the whole bug (finding #841). The moment the roster is
searched or paged, page-index numbering renumbers the visible rows `1..N` and
gilds the first four — so typing "zoe" (true rating rank ~250) paints her as
**Seed #1** with the top-seed accent, and row 1 of page 2 always shows "#1". The
column made a semantic promise — "these are the strongest players" — that a page
index cannot keep.

We decided the roster's leftmost number is a **Rank**: a player's global
position on the league's rating ladder, computed server-side and carried per-row
on `PlayerSummary` as `rank: int | None`. Rank is a *global* fact within a
league — invariant under search, pagination, and any other windowing of the
roster.

- **Computation: standard competition ranking.** `rank = 1 + the number of
  non-merged, rated players in the league with strictly greater rating`. Equal
  ratings share a rank and the next rank skips (…, 7, 7, 9, …). Strictly-greater
  gives shared ranks and null-for-unrated for free.
- **Unrated players have no rank.** A player who has never finished a rated
  match has a `NULL` league rating and therefore `rank = None`, rendered as an
  em-dash — never a number at the bottom of the list. Numbering them would
  recreate the same lie ("#251" reads as "251st best," but they are *unranked*).
- **The population excludes tombstones.** The count is taken over the same
  non-merged (`merged_into_user_id IS NULL`) population the roster itself lists,
  so a high-rated merged-away ghost cannot inflate everyone's rank.
- **The UI is unchanged in look.** The column header stays "Seed" and the gold
  top-four accent stays — only the underlying number becomes honest. The accent
  now keys off `rank != null && rank <= 4` (a naïve `rank <= 4` would gild every
  unrated player, since `null <= 4` is `true` in JS). A rating tie into the top
  four may correctly gild a fifth player.

## Considered options

- **Client-side page index (status quo).** Free, no schema change, no extra
  query — but it is only correct on the unfiltered first page and actively
  misleads under every search and on every later page. Rejected: it is the bug.
- **Drop the Seed framing whenever it can't be trusted** (blank the column under
  a filter or beyond page 1). Cheap and honest, but throws away a genuinely
  useful signal — a searching user most wants to know "how good is this player,"
  and rank answers exactly that. Rejected in favour of showing the true rank.
- **Global server-side rating rank on `PlayerSummary` (chosen).** Costs one
  extra indexed count-query per hydrate and a regeneration of the cross-platform
  generated types (`web-client/src/api/schema.d.ts`,
  `ios/Fortymm/Generated/Types.swift`). We accept that cost to make the column
  tell the truth everywhere. `rank: int | None` makes "unrated has no rank"
  unrepresentable-as-a-number at the type boundary.

## Consequences

- Rank rides on the shared `PlayerSummary`, so the profile-page hero receives it
  too. This change does **not** display it there — a scoped follow-up can, with
  its own placement/design pass.
- iOS has no roster surface (it uses `/v1/players/recent` and
  `/v1/players/search`), so the only iOS impact is the regenerated types-only
  drift guard; there is no functional iOS change.
- The next contributor who sees a whole-population count where `startIndex + i +
  1` "would do" should read this ADR before "simplifying" it: the cheap version
  is a lie under search and pagination.
