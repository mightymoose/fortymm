import type { Page, Route } from '@playwright/test'
import type { components } from '../../../src/api/schema'
import { sessionResponse } from '../../../src/test/factories'
import { fulfillParkedStream, STREAM_PATH } from '../../support/realtime'

type PlayerDetail = components['schemas']['PlayerDetail']
type PlayerSummary = components['schemas']['PlayerSummary']
type PlayerListResponse = components['schemas']['PlayerListResponse']
type PlayerMatchRow = components['schemas']['PlayerMatchRow']
type PlayerMatchListResponse = components['schemas']['PlayerMatchListResponse']
type HeadToHeadRecord = components['schemas']['HeadToHeadRecord']
type ViewerHeadToHead = components['schemas']['ViewerHeadToHead']
type RatingHistoryWindow = components['schemas']['RatingHistoryWindow']

/**
 * The player world this suite's `page.route` interceptors serve.
 *
 * **MSW is off here** (see `playwright.config.ts` → `VITE_ENABLE_MSW: 'false'`),
 * so these bodies are the *only* contract the browser ever sees on `/players/**`.
 * A drift between them and the OpenAPI schema is invisible to vitest
 * (web-client/CLAUDE.md), which is why every fixture below is written with
 * `satisfies` against the generated `components['schemas'][…]` — `tsc` on this
 * file is the drift guard.
 *
 * ## The id-drift trap this store exists to avoid
 *
 * The dev MSW world has two disjoint id spaces (the roster mints ids while the
 * match store hardcodes its own), so clicking an opponent there 404s. That is a
 * *mock* bug, but it is exactly the shape of fixture bug that would make an
 * opponent click-through test fail for a fixture reason — and tempt someone to
 * weaken the assertion. So the roster here is **one source of truth**: every
 * opponent id a profile references must resolve to a profile this store serves,
 * and `assertReferentialIntegrity()` throws at seed time if it doesn't.
 */

/** The backend's `LIST_DEFAULT_PAGE_SIZE` for `GET /v1/players/{id}/matches`. */
const HISTORY_PAGE_SIZE = 25
/** The six-row window the profile bundle embeds (`PROFILE_RECENT_MATCHES`). */
const PROFILE_RECENT_WINDOW = 6

/** Who is looking. Never the player being viewed, in any fixture below — so
 * `versus_viewer` is present, which is what makes every profile here somebody
 * *else's* (`profile-order.ts` reads own-vs-other off that field, not the
 * session). */
export const VIEWER_USERNAME = 'rita.kovac'

export const VIEWER_ID = '00000000-0000-4000-8000-0000000000aa'

/** The profile under test: two matches, two frequent opponents. */
export const OKAFOR = {
  id: '11111111-1111-4111-8111-111111111111',
  username: 'okafor.j',
} as const

/** The opponent every click-through lands on — named in OKAFOR's head-to-head
 * card *and* in a row of his Recent matches, so both links point at a profile
 * this store really serves. */
export const SILVA = {
  id: '22222222-2222-4222-8222-222222222222',
  username: 'silva.r',
} as const

/** OKAFOR's other frequent opponent. */
export const TANAKA = {
  id: '33333333-3333-4333-8333-333333333333',
  username: 'tanaka.h',
} as const

/** Never played anyone, and the viewer has never played *them* — the #1003
 * empty head-to-head, and the zero-match history (#1006's other half). */
export const HERON = {
  id: '44444444-4444-4444-8444-444444444444',
  username: 'quiet-heron',
} as const

/** Well-formed, and nobody. The API 404s it. */
export const UNKNOWN_PLAYER_ID = '99999999-9999-4999-8999-999999999999'

/** What the API actually says on a missing player (`mocks/handlers.ts` mirrors
 * the FastAPI route). Kept faithful — but note it is NOT what proves the copy is
 * designed, since it happens to read the same as the headline. */
const API_NOT_FOUND_DETAIL = 'Player not found.'

/**
 * The 500's `detail` — a raw, internals-y string of the kind a real server leaks.
 * It must never reach the screen: "raw API detail strings never reach the UI"
 * (DEFINITION_OF_COMPLETE). The error state's own copy speaks instead.
 */
export const API_SERVER_ERROR_DETAIL =
  'psycopg.OperationalError: connection refused'

const ISO = (day: number) => `2026-06-${String(day).padStart(2, '0')}T18:30:00Z`

const summary = (
  p: { id: string; username: string },
  over: Partial<PlayerSummary> = {},
): PlayerSummary =>
  ({
    id: p.id,
    username: p.username,
    rating: 1612,
    wins: 6,
    losses: 4,
    form: 'WLWWL',
    rank: 3,
    ...over,
  }) satisfies PlayerSummary

const ratingHistory = (): RatingHistoryWindow =>
  ({
    anchor: { at: ISO(1), rating: 1560, match_id: null },
    points: [
      { at: ISO(4), rating: 1584, match_id: null },
      { at: ISO(9), rating: 1600, match_id: null },
      { at: ISO(14), rating: 1612, match_id: null },
    ],
    peak: { at: ISO(14), rating: 1612, match_id: null },
    change: 52,
  }) satisfies RatingHistoryWindow

/** A decided match against a real opponent. */
export const vsOpponent = (
  id: string,
  opponent: { id: string; username: string },
  over: Partial<PlayerMatchRow> = {},
): PlayerMatchRow =>
  ({
    id,
    status: 'completed',
    created_at: ISO(14),
    opponent: { id: opponent.id, username: opponent.username },
    games: [
      { mine: 11, theirs: 7 },
      { mine: 9, theirs: 11 },
      { mine: 11, theirs: 5 },
    ],
    result: 'W',
    awaiting_acceptance: false,
    rating_change: { before: 1600, after: 1612, delta: 12 },
    ...over,
  }) satisfies PlayerMatchRow

/**
 * A **solo** match — the player-less sentinel side (ADR-0008). `id` and
 * `username` are both null on the wire, which is precisely the row that must
 * render "No opponent" as plain text and NOT a link to `/players/null` (#1005).
 */
export const soloMatch = (id: string): PlayerMatchRow =>
  ({
    id,
    status: 'completed',
    created_at: ISO(9),
    opponent: { id: null, username: null },
    games: [],
    result: null,
    awaiting_acceptance: false,
    rating_change: null,
  }) satisfies PlayerMatchRow

const h2hRecord = (
  opponent: { id: string; username: string },
  wins: number,
  losses: number,
): HeadToHeadRecord =>
  ({
    opponent: { id: opponent.id, username: opponent.username },
    wins,
    losses,
    meetings: wins + losses,
  }) satisfies HeadToHeadRecord

const viewerRecord = (
  player: { id: string; username: string },
  wins: number,
  losses: number,
  lastMeeting: string | null,
): ViewerHeadToHead =>
  ({
    opponent: { id: player.id, username: player.username },
    wins,
    losses,
    last_meeting: lastMeeting,
    meetings: wins + losses,
  }) satisfies ViewerHeadToHead

export interface PlayerSeed {
  id: string
  username: string
  rating?: number | null
  /** The **viewer's** record against this player. Every seed here has one — an
   * absent one would mean "this is your own profile". */
  versusViewer: ViewerHeadToHead
  /** *Their* rivalries, shown under the viewer's record. */
  frequentOpponents?: HeadToHeadRecord[]
  /** Their full history, newest first. The bundle embeds the first six; the
   * match-history route pages through all of them. */
  matches?: PlayerMatchRow[]
}

/** The bundle `GET /v1/players/{id}` answers with. */
const buildDetail = (seed: PlayerSeed): PlayerDetail => {
  const matches = seed.matches ?? []
  const rated = seed.rating ?? null
  return {
    ...summary(seed, { rating: rated }),
    member_since: '2024-02-11T00:00:00Z',
    rating_delta: rated == null ? null : { before: 1600, after: rated, delta: 12 },
    peak: rated,
    rank_of: 40,
    confidence:
      rated == null
        ? null
        : {
            deviation: 74,
            volatility: 0.06,
            interval: { low: rated - 148, high: rated + 148 },
            level: 'firming_up',
          },
    percentile: 82,
    matches: {
      items: matches.slice(0, PROFILE_RECENT_WINDOW),
      page: 1,
      page_size: PROFILE_RECENT_WINDOW,
      total: matches.length,
    },
    match_total: matches.length,
    career: {
      decided: 10,
      wins: 6,
      losses: 4,
      win_rate: 0.6,
      games_won_pct: 0.55,
      current_streak: { kind: 'W', n: 2 },
      best_streak: { kind: 'W', n: 4 },
      league_count: 1,
    },
    leagues: [
      {
        id: '55555555-5555-4555-8555-555555555555',
        name: 'FortyMM',
        is_default: true,
        rating: rated,
      },
    ],
    head_to_head: {
      versus_viewer: seed.versusViewer,
      frequent_opponents: seed.frequentOpponents ?? [],
    },
    rating_history: ratingHistory(),
  } satisfies PlayerDetail
}

/** OKAFOR's history: a real opponent (linkable) and a solo match (not). */
const OKAFOR_MATCHES: PlayerMatchRow[] = [
  vsOpponent('aaaaaaaa-0000-4000-8000-000000000001', SILVA),
  soloMatch('aaaaaaaa-0000-4000-8000-000000000002'),
]

/**
 * The default roster.
 *
 * Every opponent id named below belongs to a player this store also serves —
 * that is the whole point (see the header). `assertReferentialIntegrity` proves
 * it rather than trusting it.
 */
export const DEFAULT_ROSTER: PlayerSeed[] = [
  {
    ...OKAFOR,
    rating: 1612,
    // The viewer has played OKAFOR — so his profile leads with "You're 1–4
    // against okafor.j", not the invite.
    versusViewer: viewerRecord(OKAFOR, 1, 4, ISO(14)),
    frequentOpponents: [h2hRecord(SILVA, 6, 2), h2hRecord(TANAKA, 3, 3)],
    matches: OKAFOR_MATCHES,
  },
  {
    ...SILVA,
    rating: 1488,
    versusViewer: viewerRecord(SILVA, 2, 2, ISO(4)),
    frequentOpponents: [h2hRecord(OKAFOR, 2, 6)],
    matches: [vsOpponent('bbbbbbbb-0000-4000-8000-000000000001', OKAFOR)],
  },
  {
    ...TANAKA,
    rating: 1530,
    versusViewer: viewerRecord(TANAKA, 0, 1, ISO(1)),
    frequentOpponents: [h2hRecord(OKAFOR, 3, 3)],
    matches: [vsOpponent('cccccccc-0000-4000-8000-000000000001', OKAFOR)],
  },
  {
    ...HERON,
    // Unrated: never played a match, so no rating, no chart, no confidence.
    rating: null,
    // Zero meetings with the viewer → `neverMet` → the invite + Start-a-match
    // CTA (#1003), and zero rivalries of their own → the labelled empty section.
    versusViewer: viewerRecord(HERON, 0, 0, null),
    frequentOpponents: [],
    matches: [],
  },
]

export interface PlayerStoreSeed {
  roster?: PlayerSeed[]
  /** Player ids whose `GET /v1/players/{id}` answers 500 — the retryable error
   * branch. Mutable at runtime via `failProfile` / `healProfile`, so a spec can
   * heal the route and click "Try again". */
  failing?: string[]
}

/**
 * Mocks every endpoint `/players/**` touches — `GET /v1/session`,
 * `GET /v1/players`, `GET /v1/players/{id}`, `GET /v1/players/{id}/matches` and
 * `GET /v1/players/{id}/rating-history` — through a single `page.route`
 * interceptor that dispatches on the pathname. One handler, so there is no
 * registration-order subtlety between a `/players` and a `/players/{id}` glob.
 */
export class PlayerStore {
  /** Paths the app asked for, in order — a spec can assert the page paints from
   * ONE bundle request. */
  readonly requests: string[] = []

  private readonly roster: Map<string, PlayerSeed>
  private readonly failing: Set<string>

  constructor(seed: PlayerStoreSeed = {}) {
    const roster = seed.roster ?? DEFAULT_ROSTER
    this.roster = new Map(roster.map((p) => [p.id, p]))
    this.failing = new Set(seed.failing ?? [])
    this.assertReferentialIntegrity()
  }

  /**
   * Every opponent this world names must be a player this world can serve.
   *
   * Loud, at seed time, because the alternative is a click-through test that
   * fails deep in a browser with "expected heading silva.r" and looks like a
   * product bug.
   */
  private assertReferentialIntegrity(): void {
    for (const seed of this.roster.values()) {
      const referenced = [
        ...(seed.frequentOpponents ?? []).map((r) => r.opponent.id),
        ...(seed.matches ?? [])
          .map((m) => m.opponent.id)
          // A solo match has no opponent — nothing to resolve, by design.
          .filter((id): id is string => id != null),
      ]
      for (const id of referenced) {
        if (!this.roster.has(id)) {
          throw new Error(
            `PlayerStore fixture drift: ${seed.username} names opponent ${id}, ` +
              `but no profile in the roster answers to it. A link rendered from ` +
              `this payload would 404 for a fixture reason, not a product one.`,
          )
        }
      }
    }
  }

  /** Make this player's bundle 500. The handler reads the set per request, so a
   * spec can flip it mid-test. */
  failProfile(playerId: string): void {
    this.failing.add(playerId)
  }

  /** …and heal it, so the boundary's "Try again" has something to succeed at. */
  healProfile(playerId: string): void {
    this.failing.delete(playerId)
  }

  async install(page: Page): Promise<void> {
    await page.route('**/api/v1/**', (route: Route) => {
      const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
      const search = new URL(route.request().url()).searchParams

      // Answered before the tally: the shell's realtime stream is infrastructure
      // every authenticated page opens, not a read this store's specs are
      // narrating (`../../support/realtime`).
      if (path === STREAM_PATH) return fulfillParkedStream(route)

      this.requests.push(path)

      if (path === '/v1/session') return json(route, this.session())
      if (path === '/v1/players') return json(route, this.list(search))

      const detail = /^\/v1\/players\/([^/]+)$/.exec(path)
      if (detail) return this.profile(route, decodeURIComponent(detail[1]))

      const matches = /^\/v1\/players\/([^/]+)\/matches$/.exec(path)
      if (matches) {
        return this.matches(route, decodeURIComponent(matches[1]), search)
      }

      const history = /^\/v1\/players\/([^/]+)\/rating-history$/.exec(path)
      if (history) {
        const player = this.roster.get(decodeURIComponent(history[1]))
        if (!player) return notFound(route)
        return json(route, ratingHistory())
      }

      // Anything else the shell happens to reach for.
      return json(route, [])
    })
  }

  private session() {
    return sessionResponse({
      user: { id: VIEWER_ID, username: VIEWER_USERNAME },
    })
  }

  private list(search: URLSearchParams): PlayerListResponse {
    const q = search.get('q')?.trim().toLowerCase()
    const items = [...this.roster.values()]
      .filter((p) => !q || p.username.toLowerCase().includes(q))
      .map((p) => summary(p, { rating: p.rating ?? null }))
    return {
      items,
      page: Number(search.get('page') ?? 1),
      page_size: Number(search.get('page_size') ?? HISTORY_PAGE_SIZE),
      total: items.length,
    } satisfies PlayerListResponse
  }

  private profile(route: Route, playerId: string) {
    if (this.failing.has(playerId)) {
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ detail: API_SERVER_ERROR_DETAIL }),
      })
    }
    const seed = this.roster.get(playerId)
    if (!seed) return notFound(route)
    return json(route, buildDetail(seed))
  }

  private matches(route: Route, playerId: string, search: URLSearchParams) {
    const seed = this.roster.get(playerId)
    if (!seed) return notFound(route)
    const rows = seed.matches ?? []
    const page = Math.max(1, Number(search.get('page') ?? 1))
    const pageSize = Math.max(
      1,
      Number(search.get('page_size') ?? HISTORY_PAGE_SIZE),
    )
    const start = (page - 1) * pageSize
    const body: PlayerMatchListResponse = {
      items: rows.slice(start, start + pageSize),
      page,
      page_size: pageSize,
      total: rows.length,
    }
    return json(route, body)
  }
}

function json(route: Route, body: unknown) {
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

function notFound(route: Route) {
  return route.fulfill({
    status: 404,
    contentType: 'application/json',
    body: JSON.stringify({ detail: API_NOT_FOUND_DETAIL }),
  })
}
