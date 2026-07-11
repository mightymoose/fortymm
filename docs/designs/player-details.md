# Player details page — refactor

Rebuilds `/players/$userId` against the [Player Details mockup][mockup]: an
overview page (hero, rating chart, career, confidence, leagues, head-to-head,
recent matches) in place of today's hero + paginated table.

[mockup]: https://claude.ai/design/p/0c7326c8-59c0-4753-8d33-184ca9be1724?file=Player+Details.dc.html

Decisions live in four ADRs, all numbered `0915` after the PR that introduced them
(ADR numbers in this repo are not a sequence — numbering off `max + 1` from a
stale main is how we ended up with four `0008`s): [league scope][a15],
[overview + sub-route][a16], [the chart][a17], [viewer-aware][a18]. New vocabulary
lives in `CONTEXT.md` (*Game*, *League*, *Default league*, *Career*, *Peak
rating*, *Rating confidence*, *Form*, *Streak*, *Games won*, *Meeting*,
*Head-to-head*).

[a15]: ../adr/0915-the-profile-is-league-scoped-for-rating-and-cross-league-for-career.md
[a16]: ../adr/0915-the-profile-is-an-overview-and-full-match-history-is-its-own-route.md
[a17]: ../adr/0915-the-rating-chart-is-a-calendar-window-with-a-carry-in-anchor.md
[a18]: ../adr/0915-the-player-profile-is-viewer-aware.md

## What the mockup asks for, and what backs it

| Card | Backing today |
| --- | --- |
| Hero: rating, rank, form | **On the wire, unrendered.** `PlayerSummary` already sends `rank` + `form`; the hero throws them away. |
| Hero: peak, `+12` delta | **Computed, but only for the dashboard.** `_league_peak_rating`, `RatingChange`. Lift onto `PlayerDetail`. |
| Hero: member since | `User.created_at` exists; exposed only on the admin RBAC schema. |
| Career: W–L, win rate | `wins`/`losses` exist. Win rate is `wins / (wins + losses)`. |
| Career: current streak | `dashboard.py::_current_streak` exists (dashboard-only, 100-match scan cap). |
| Career: best streak | **New.** Same walk; the scan cap has to lift. |
| Career: games won % | **New.** Nothing aggregates a games-won ratio today. |
| Rating confidence | **New shaping** over existing `rating_state` JSONB (`rd`, `volatility`). |
| Rating history chart | **New endpoint** over the existing append-only `rating_history` table. |
| Head-to-head | **New query.** `_load_head_to_head` exists but is scoped to a *match's* two participants, not to a player's opponents. |
| Leagues | Models exist (`leagues`, `league_memberships`, per-`(user, league)` ratings). No join endpoint — every user is in the default league today. |

Nothing on the page is fiction. Multi-league is real in the schema and renders one
row per user until USATT lands.

## Dropped from the mockup

- **The `@perky-ringtail` line.** The username *is* the handle; the mockup prints
  the same string twice.
- **The All / Wins / Losses tabs** on Recent matches. They filter six rows
  client-side, which tells you nothing, and a live match is neither a win nor a
  loss so it vanishes under two of the three tabs. If the filter is ever wanted it
  belongs on the sub-route as a server-side `result=` param.
- **The 86% confidence bar.** An arbitrary rescaling of RD onto a 0–100 axis. The
  95% interval says the same thing rigorously, so it moves onto the card face and
  RD/σ stay in the `<details>` drawer.
- **"Top 8%"** as the hero's headline standing. In a twelve-player alpha, "top 8%"
  means *you are first*, dressed as a statistic. The hero leads with **rank**
  (`#3 of 42 in FortyMM`); percentile appears alongside it only once the league is
  big enough for the number to mean anything (see the API section — the threshold
  is provisional).
- **"Sets won".** There are no sets. See below.

## Renames

`PlayerMatchRow.sets` → `games`, `PlayerMatchSet` → `PlayerMatchGame`. The
model's own docstring already read *"A single game's score"* — the field name was
always wrong. This is a `[main]` cross-layer step: regen `schema.d.ts` **and**
`ios/Fortymm/Generated/Types.swift`. iOS has no player-details screen and no
hand-written Swift touches the type, so it is 7 lines of generated code and no app
change.

## API

### `GET /v1/players/{id}?league_id=&range=90d` → `PlayerDetail` (the BFF bundle)

One request paints the page. Extends today's bundle:

- `PlayerSummary` fields (`rating`, `rank`, `wins`, `losses`, `form`) — **now
  league-scoped by `league_id`**.
- `form` widens from 5 to 10. **`form` lives on `PlayerSummary`, which the
  `/players` roster also serializes** — so widening it means the roster ships a
  10-char string for every row and slices the first 5 client-side. That is the
  intended trade (one shared field, a few bytes per roster row) rather than a
  second, wider field on `PlayerDetail`; name it here so nobody "optimises" the
  roster back to 5 and silently truncates the profile.
- `member_since: datetime` — from `User.created_at`.
- `rating_delta: RatingChange | null` — from the most recent rated match. `null`,
  never `0`, when there is none.
- `peak: float | null`, `rank_of: int | null` (rated population, so `#3 of 42`
  can't flatter), `percentile: int | null`. **Provisional:** percentile is
  suppressed below 50 rated players in the league. The *principle* is settled — a
  percentile over a tiny population flatters and must not headline — but 50 is a
  guess, not a ratified number. Put it in one named constant.
- `confidence: RatingConfidence | null` — `{ level: "provisional" | "firming_up" |
  "settled", deviation, volatility, interval: { low, high } }`. Level keys on RD:
  `≥160` provisional, `90–160` firming up, `<90` settled. Interval is
  `rating ± 1.96 × RD`. `null` for an unrated player.
- `career: PlayerCareer` — **cross-league**, ignores `league_id`:
  `{ decided, wins, losses, win_rate, games_won_pct, current_streak, best_streak,
  league_count }`.
- `leagues: list[PlayerLeague]` — `{ id, name, is_default, rating }`, one row per
  membership.
- `head_to_head: PlayerHeadToHead` — viewer-aware, see below.
- `matches: PlayerMatchListResponse` — the recent **6** (was: page 1 of 25).
- `match_total: int` — the *all-inclusive* history count, for the "View all N
  matches" link. **Deliberately ≠ `career.decided`** (see ADR-0016).

`PlayerMatchRow` also gains `rating_change: RatingChange | null` — the rating the
match moved, for the row's Δ column, read from that match's `rating_history` row.
`null` (rendered `—`, never `+0`) for any row that is undecided *or* unrated.
- `rating_history: RatingHistoryWindow` — the `range` window, inline, so first
  paint costs one request.

### `GET /v1/players/{id}/rating-history?league_id=&range=30d|90d|1y`

`{ anchor: Point | null, points: list[Point], peak: Point | null, change: float | null }`
where `Point = { at: datetime, rating: float, match_id: uuid | null }`.

The **anchor** is the rating as of the window start, read from the last history
row *at or before* it — from outside the window. It is what makes "+127 over 90
days" true. See ADR-0017.

### `GET /v1/players/{id}/matches?page=&page_size=`

Unchanged. Backs the new sub-route.

### Head-to-head (viewer-aware)

`{ versus_viewer: { opponent, wins, losses, meetings, last_meeting } | null,
frequent_opponents: list[{ opponent, wins, losses, meetings }] }`

`versus_viewer` is `null` on your own profile. `frequent_opponents` is the top 3
by meetings, ties broken by most recent. A **meeting** is a *decided* match
(rated or not) — see `CONTEXT.md`.

## Web client

### URL

`/players/$userId?league=<id>&range=90d` — both Zod-validated in `validateSearch`
with `.catch()` fallbacks, so a mangled URL degrades. `league` is omitted when it
is the default. `page` moves to `/players/$userId/matches?page=`.

### Data flow — the match-details projection pattern

One cache entry, keyed `[{ scope: "players", version: "v1", entity: "details",
playerId, league, range }]`. Every card is a derived query that **spreads the base
and adds a `select`** — same key, same fetch, its own view model:

```ts
export const heroQuery = (id: string, opts: Opts) => ({
  ...playerDetailsQuery(id, opts),
  select: selectHero,
})
```

Nine cards, one request. Projections live in `*-query.ts` next to their fetcher,
are tested headlessly through `renderHook` (no DOM), and a test pins the shared
key so the BFF fetch can't silently fork. The route loader does
`void context.queryClient.prefetchQuery(playerDetailsQuery(...))` — fire-and-forget,
non-blocking, exactly as `matches.$matchId.index.tsx` does.

**The chart is the one exception.** A range flip must fetch *only* the range, so it
owns a query against `/rating-history`, keyed on `range`. Its cache is **seeded from
the bundle** for the initially-loaded range via
`initialData: () => queryClient.getQueryData(bundleKey)?.rating_history` +
`initialDataUpdatedAt` — the same trick `usePlayerMatches` already uses to seed
page 1 from `PlayerDetail.matches`. First paint: no extra request. Flip to `30d`:
one narrow fetch. Flip back: cache hit.

Switching **league** re-keys the bundle, so the whole page refetches — correct,
since a league switch changes the hero, the confidence card, the chart *and* the
Leagues highlight at once.

### Loading and errors

**The eight bundle-backed cards**: per-card `<Suspense>` with a hand-mirrored
skeleton (`role="status"`, `aria-busy`), `useSuspenseQuery` in the fetcher — no
`isLoading` branching, no page-level skeleton. `throwOnError: true` and **no
per-card error boundaries**, exactly as match-details: all eight share one query,
so a failure means none of them has anything to draw, and it throws to the route's
`PlayerRouteError` (4xx → "Player not found", no retry; 5xx → "Couldn't load this
player" + Try again).

**The chart is the exception, and it cannot use `useSuspenseQuery`.** Two of its
requirements are things `useSuspenseQuery` structurally cannot do: it always
throws to the nearest boundary (there is no `throwOnError: false` for it), and a
key change re-suspends the card to its skeleton. But a range flip must (a) keep
the old chart on screen while the new range loads, and (b) fail *inside the card*
— blanking a fully-painted profile because someone clicked "30d" would be absurd.

So the chart's fetcher is **`useQuery`**, with `placeholderData: keepPreviousData`
and `throwOnError: false`, rendering an inline "Couldn't load that range · Try
again" in place of the SVG on failure. That is not a new pattern: it is precisely
what `usePlayerMatches` does today (`keepPreviousData`, no `throwOnError`, inline
`MatchesError` that "does not blow away the whole page"). Its *initial* load still
costs no request and no spinner, because its cache is seeded from the bundle.

### Component tree

Quartet per component (component + `.page.tsx` + `.factory.tsx` + `.test.tsx`),
wrapper → fetcher → display, per the `react-component` skill. `player-profile.tsx`
is 550 lines with **no test, page object or factory** today; it does not survive as
one file.

```
player-profile.tsx                    composition root — takes playerId only
├── profile-hero/                     avatar, name, member-since, leagues chip
├── rating-panel/                     1687, Δ chip, #3 of 42, peak, form (10)
├── rating-chart/                     own query; range tabs; own error state
├── career-card/                      win-rate donut, W·L, streak, best streak, games won
├── rating-confidence/                dot + level + 95% interval; RD/σ in <details>
├── leagues-card/                     the league switcher
├── head-to-head/                     viewer-aware: "You vs them" | "Frequent opponents"
└── recent-matches/                   last 6 + "View all N matches →"

routes/_app/players/$userId.matches.tsx   the paginated table, moved wholesale
```

### The Recent matches row

Grid is `Opponent | Score | Δ | When` — no result-chip column. The list stays
**all-inclusive** (ADR-0008), so status is carried by:

- the **status dot**: green won · red lost · amber awaiting · pulsing orange live
  · hollow up-next · grey voided
- the **score cell**: "Live" / "Awaiting" / "—" where a score would go
- **Δ**: `—` for anything undecided *or* unrated. Never `+0`.

### Mobile

Single column. Order depends on the viewer (ADR-0018) — on a phone only the first
screen and a half get read, and on an opponent's profile that real estate belongs
to "am I going to beat this person, and shall we play now":

- **Someone else:** hero → **You vs them** → recent matches → career → chart →
  confidence → leagues
- **Yourself:** hero → career → chart → recent matches → confidence → leagues →
  frequent opponents

The chart scales by `viewBox`; drop gridline labels below ~480px and let the range
tabs wrap.

### Other web changes

- **`?opponent=<userId>` on `/matches/new`**, preseeding the opponent picker. The
  route has **no `validateSearch` at all** today, so the "Start a match" CTA has
  nothing to prefill into. New public URL contract on an existing route: Zod-
  validated, `.catch()`ing an unknown id back to the empty picker rather than
  erroring.
- **"Your profile" link in the user menu.** The app has never had one — the only
  way to reach your own profile is to find yourself on the roster.
- Delete the `.player-profile--standalone` CSS variant. It exists for a "public
  route" that was never built.
- The page stops being a fixed-height pane (`height: calc(100vh - topbar)` with an
  independently-scrolling table) and becomes a normal scrolling document.

## Testing

- **API (pytest)** carries the domain logic: confidence levels and their
  boundaries, streaks (current + best), games-won %, the chart's carry-in anchor
  and empty window, viewer-aware head-to-head (incl. the guest / never-met case),
  rank + population, percentile suppression, `career.decided` ≠ `match_total`.
- **vitest** is thin: projections tested through `renderHook` with no DOM; displays
  tested through page objects over factories.
- **One Playwright spec** on the composed stack for what only breaks in a browser:
  the league switch and the range-tab fetch (the URL round-trip, the seeded-cache
  first paint, the narrow refetch). The page has **zero** browser coverage today.

## Slices

Demoable, in order:

1. **Rename + regen.** `sets` → `games` across api, `schema.d.ts`, `Types.swift`.
   `[main]` owns the regen.
2. **Bundle groundwork.** `PlayerDetail` grows `member_since`, `rating_delta`,
   `peak`, `rank_of`, `percentile`, `confidence`, `career`, `leagues`,
   `match_total`; `form` widens to 10; recent matches drop to 6. Pytest-covered.
   Nothing renders yet.
3. **The sub-route.** `/players/$userId/matches` — table, pagination, snap-back
   and its tests move across intact. Profile still renders the old way.
4. **The overview shell.** Hero, rating panel, career, leagues, confidence —
   projections off the bundle, quartets, skeletons. The profile becomes the new
   page. Recent-matches card + "View all" links to slice 3.
5. **Head-to-head.** New API aggregation + the viewer-aware card + "Start a match"
   CTA + the user-menu "your profile" link.
6. **The chart.** `/rating-history` endpoint (anchor, window, peak, change) + the
   card, its own query, seeded cache, range tabs, own error state.
7. **Playwright + mobile.** The browser spec, the viewer-dependent mobile order.
