import type { Page, Request as PWRequest, Route } from '@playwright/test'
import type { components } from '../../../src/api/schema'
import { matchResponse, sessionResponse } from '../../../src/test/factories'

type Player = components['schemas']['PlayerRead']
type MatchCreate = components['schemas']['MatchCreate']

/** Username the mocked session resolves to — the "You" side of every match. */
export const CREATOR_USERNAME = 'rita.kovac'

const SESSION = sessionResponse({ user: { username: CREATOR_USERNAME } })

export interface FailureSpec {
  status: number
  /** `detail` string the API would return; the form surfaces it inline. */
  detail?: string
  /** Hold the response this many ms before replying. */
  delayMs?: number
}

export interface MatchStoreSeed {
  /** Registered players the opponent picker can choose from. */
  players?: Player[]
}

/**
 * Mocks the three endpoints the New Match page touches — `GET /v1/session`,
 * `GET /v1/players`, and `POST /v1/matches` — entirely in the browser via
 * `page.route`, so the e2e suite never needs a live API. Records every
 * create-match body the client sends so specs can assert on the payload.
 */
export class MatchStore {
  readonly creatorUsername = CREATOR_USERNAME
  /** Bodies of every `POST /v1/matches`, in the order the client sent them. */
  readonly createdMatches: MatchCreate[] = []

  private readonly players: Player[]
  private readonly createFailures: FailureSpec[] = []

  constructor(seed: MatchStoreSeed = {}) {
    this.players = seed.players ?? []
  }

  /**
   * Queue a failure for the next `POST /v1/matches`. Call once per failure you
   * want — later creates succeed, which makes retry-after-error testable.
   */
  failNextCreate(spec: FailureSpec): void {
    this.createFailures.push({ ...spec })
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
    if (path === '/v1/players' && method === 'GET') {
      return this.json(route, 200, this.players)
    }
    if (path === '/v1/matches' && method === 'POST') {
      return this.handleCreate(route, request)
    }
    return this.json(route, 404, { detail: `unmocked ${method} ${path}` })
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
