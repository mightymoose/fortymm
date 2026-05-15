import type { Page, Request as PWRequest, Route } from '@playwright/test'
import type { components } from '../../../src/api/schema'
import { matchResponse, sessionResponse } from '../../../src/test/factories'

type Player = components['schemas']['PlayerRead']
type MatchCreate = components['schemas']['MatchCreate']

/** Username the mocked session resolves to — the "You" side of every match. */
export const CREATOR_USERNAME = 'rita.kovac'

const SESSION = sessionResponse({ user: { username: CREATOR_USERNAME } })

/** The recent-opponents endpoint is capped at six chips. */
const RECENT_LIMIT = 6
/** The search endpoint caps its result count. */
const SEARCH_LIMIT = 10

export interface FailureSpec {
  status: number
  /** `detail` string the API would return; the form surfaces it inline. */
  detail?: string
  /** Hold the response this many ms before replying. */
  delayMs?: number
}

export interface MatchStoreSeed {
  /** Registered players the typeahead search can match against. */
  players?: Player[]
  /**
   * Opponents the default picker grid shows, in order (most-recently-played
   * first). Defaults to the first six `players`.
   */
  recentOpponents?: Player[]
  /**
   * Hold the recent / search responses this long before replying, so specs
   * can observe the skeleton and loading states.
   */
  recentDelayMs?: number
  searchDelayMs?: number
  /** Fail the first recent / search request (drives the error boundary). */
  failRecent?: FailureSpec
  failSearch?: FailureSpec
}

/**
 * Mocks the endpoints the New Match page touches — `GET /v1/session`,
 * `GET /v1/players/recent`, `GET /v1/players/search`, and `POST /v1/matches` —
 * entirely in the browser via `page.route`, so the e2e suite never needs a
 * live API. Records the create-match bodies and the search terms the client
 * sends so specs can assert on them.
 */
export class MatchStore {
  readonly creatorUsername = CREATOR_USERNAME
  /** Bodies of every `POST /v1/matches`, in the order the client sent them. */
  readonly createdMatches: MatchCreate[] = []
  /** `q` values the client sent to `GET /v1/players/search`, in order. */
  readonly searchQueries: string[] = []

  private readonly players: Player[]
  private readonly recentOpponents: Player[]
  private readonly recentDelayMs: number
  private readonly searchDelayMs: number
  private readonly createFailures: FailureSpec[] = []
  private readonly recentFailures: FailureSpec[] = []
  private readonly searchFailures: FailureSpec[] = []

  constructor(seed: MatchStoreSeed = {}) {
    this.players = seed.players ?? []
    this.recentOpponents =
      seed.recentOpponents ?? this.players.slice(0, RECENT_LIMIT)
    this.recentDelayMs = seed.recentDelayMs ?? 0
    this.searchDelayMs = seed.searchDelayMs ?? 0
    if (seed.failRecent) this.recentFailures.push({ ...seed.failRecent })
    if (seed.failSearch) this.searchFailures.push({ ...seed.failSearch })
  }

  /**
   * Queue a failure for the next `POST /v1/matches`. Call once per failure you
   * want — later creates succeed, which makes retry-after-error testable.
   */
  failNextCreate(spec: FailureSpec): void {
    this.createFailures.push({ ...spec })
  }

  /** Queue a failure for the next `GET /v1/players/recent`. */
  failNextRecent(spec: FailureSpec): void {
    this.recentFailures.push({ ...spec })
  }

  /** Queue a failure for the next `GET /v1/players/search`. */
  failNextSearch(spec: FailureSpec): void {
    this.searchFailures.push({ ...spec })
  }

  async install(page: Page): Promise<void> {
    await page.route('**/api/v1/**', (route) => this.handle(route))
  }

  private async handle(route: Route): Promise<void> {
    const request = route.request()
    const method = request.method()
    const path = new URL(request.url()).pathname.replace(/^\/api/, '')

    if (path === '/v1/session') {
      return this.json(route, 200, SESSION)
    }
    if (path === '/v1/players/recent' && method === 'GET') {
      return this.handleRecent(route)
    }
    if (path === '/v1/players/search' && method === 'GET') {
      return this.handleSearch(route, request)
    }
    if (path === '/v1/matches' && method === 'POST') {
      return this.handleCreate(route, request)
    }
    return this.json(route, 404, { detail: `unmocked ${method} ${path}` })
  }

  private async handleRecent(route: Route): Promise<void> {
    if (this.recentDelayMs) await wait(this.recentDelayMs)
    const failure = this.recentFailures.shift()
    if (failure) {
      if (failure.delayMs) await wait(failure.delayMs)
      return this.json(route, failure.status, {
        detail: failure.detail ?? `mock ${failure.status}`,
      })
    }
    return this.json(route, 200, this.recentOpponents)
  }

  private async handleSearch(route: Route, request: PWRequest): Promise<void> {
    if (this.searchDelayMs) await wait(this.searchDelayMs)
    const failure = this.searchFailures.shift()
    if (failure) {
      if (failure.delayMs) await wait(failure.delayMs)
      return this.json(route, failure.status, {
        detail: failure.detail ?? `mock ${failure.status}`,
      })
    }
    const q =
      new URL(request.url()).searchParams.get('q')?.trim().toLowerCase() ?? ''
    this.searchQueries.push(q)
    if (!q) return this.json(route, 200, [])
    const matches = this.players
      .filter((p) => p.username.toLowerCase().includes(q))
      .slice(0, SEARCH_LIMIT)
    return this.json(route, 200, matches)
  }

  private async handleCreate(route: Route, request: PWRequest): Promise<void> {
    const body = readJson(request) as MatchCreate
    this.createdMatches.push(body)

    const failure = this.createFailures.shift()
    if (failure) {
      if (failure.delayMs) await wait(failure.delayMs)
      return this.json(route, failure.status, {
        detail: failure.detail ?? `mock ${failure.status}`,
      })
    }

    const opponent =
      body.opponent_user_id == null
        ? null
        : (this.players.find((p) => p.id === body.opponent_user_id) ?? null)

    return this.json(
      route,
      201,
      matchResponse({
        creatorUsername: this.creatorUsername,
        opponent,
        bestOf: body.best_of,
        rated: body.rated,
      }),
    )
  }

  private json(route: Route, status: number, body: unknown): Promise<void> {
    return route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    })
  }
}

function readJson(request: PWRequest): unknown {
  const text = request.postData()
  return text ? JSON.parse(text) : undefined
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
