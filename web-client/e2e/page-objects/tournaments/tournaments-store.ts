import type { Page, Route } from '@playwright/test'

import type { components } from '../../../src/api/schema'
import { PERM } from '../../../src/lib/permissions'
import {
  buildTournamentDetailRead,
  buildTournamentEventRead,
  buildTournamentEntrantRead,
} from '../../../src/mocks/factories/tournaments/tournament.factory'
import { sessionResponse } from '../../../src/test/factories'

type TournamentDetailRead = components['schemas']['TournamentDetailRead']
type TournamentEventRead = components['schemas']['TournamentEventRead']
type TournamentEntrantRead = components['schemas']['TournamentEntrantRead']
type UnreadCountResponse = components['schemas']['UnreadCountResponse']

/** The app shell's notification bell polls this on every page, tournaments
 * included. It is nothing to do with entries — but with MSW off, an unanswered
 * call falls through to the vite dev server, so the shell around the feature has
 * to be fed too. */
const UNREAD_COUNT: UnreadCountResponse = { unread_count: 0 }

/**
 * A **stateful** network stub for the tournament-entries journey, installed as
 * Playwright `page.route` interceptors (this suite runs with MSW OFF).
 *
 * Stateful is not a nicety here, it is the whole requirement: the journey is
 * enter → withdraw → **re-enter**, and each step's assertion is about what the
 * *next* read returns. A static fixture cannot express "the roster now contains
 * me and the count went up", so a spec built on one would assert the fixture,
 * not the app.
 *
 * It is a **per-test instance**, never a module singleton: the suite runs
 * `fullyParallel`, and a shared store would let one test's entry leak into
 * another's "am I entered?" join.
 *
 * The wire shapes come from the same generated-schema-typed factories the MSW
 * mocks use, so a change to the OpenAPI contract reds this file at review time
 * rather than passing a stale shape into a green spec.
 */

export const TOURNAMENT_ID = 'bay-area-open-2026'

/** The events the specs drive, named so the specs never hard-code strings that
 * must agree with the seed below. */
export const EVENT = {
  /** Singles, 2 existing entrants, 64 slots — the enter/withdraw/re-enter one. */
  JOURNEY: 'Open Singles',
  /** Singles, nobody entered — the designed *empty* roster state. */
  EMPTY: 'U1500 Singles',
  /** Doubles — the *entry-closed* roster state, and no Enter control at all. */
  DOUBLES: 'Mixed Doubles',
  /** Singles with more entrants than a card lists — the *truncated* roster.
   * Opt-in (`crowded: true`), so the default seed's counts stay the ones the
   * other specs narrate. */
  CROWDED: 'Veterans Singles',
} as const

/** How many people are already in the crowded event before I enter it. Comfortably
 * past the card's 8-chip cut-off, so my own entry — appended LAST, the server lists
 * entrants oldest-entry-first — is truncated away unless the roster pins it (#781). */
const CROWD_SIZE = 12

/**
 * ⚠️ The join key. The session payload carries a username and **no user id**, so
 * "am I entered?" is decided by matching an entrant's `username` against the
 * session's. The username the store stamps on an entry it mints MUST therefore
 * be the same one the session reports — otherwise the player enters, the roster
 * gains a stranger, Withdraw never appears, and the spec looks like an app bug.
 * One constant, used for both.
 */
export const ME = { username: 'rita.kovac', userId: 'u-me' } as const

/** Entrants that are *not* me — so the journey event starts with a real count to
 * increment, and the roster has something to show before I join it. */
const OTHERS: TournamentEntrantRead[] = [
  buildTournamentEntrantRead({ id: 'entry-1', user_id: 'u-1', username: 'player.1' }),
  buildTournamentEntrantRead({ id: 'entry-2', user_id: 'u-2', username: 'player.2' }),
]

/** A crowd of strangers, `player.1` … `player.N`, in entry order — the roster a
 * late entrant lands behind. */
function crowd(size: number): TournamentEntrantRead[] {
  return Array.from({ length: size }, (_, i) =>
    buildTournamentEntrantRead({
      id: `entry-crowd-${i + 1}`,
      user_id: `u-crowd-${i + 1}`,
      username: `player.${i + 1}`,
    }),
  )
}

/** All three roster states (`listed` / `empty` / `entry-closed`) on one page, on
 * purpose: it is the real shape of an Events tab, and it lets one axe scan cover
 * every state the roster can be in.
 *
 * The fourth — a roster *longer than the card lists* — is opt-in (`crowded`),
 * because its dozen entrants would move the tournament-level Entries total that
 * the journey spec asserts on. */
function seed(crowded: boolean): TournamentDetailRead {
  return buildTournamentDetailRead({
    id: TOURNAMENT_ID,
    events: [
      buildTournamentEventRead({
        id: 'ev-open-singles',
        name: EVENT.JOURNEY,
        format: 'singles',
        max_players: 64,
        entrants: OTHERS,
      }),
      buildTournamentEventRead({
        id: 'ev-u1500',
        name: EVENT.EMPTY,
        format: 'singles',
        max_players: 48,
        entrants: [],
        pools: [],
      }),
      buildTournamentEventRead({
        id: 'ev-mixed-doubles',
        name: EVENT.DOUBLES,
        format: 'doubles',
        max_players: 32,
        entrants: [],
        pools: [],
      }),
      ...(crowded
        ? [
            buildTournamentEventRead({
              id: 'ev-veterans',
              name: EVENT.CROWDED,
              format: 'singles',
              max_players: 64,
              entrants: crowd(CROWD_SIZE),
              pools: [],
            }),
          ]
        : []),
    ],
  })
}

export interface TournamentsStoreOptions {
  /** The signed-in player's permissions. Defaults to a beta tester (can enter).
   * Pass `[PERM.TOURNAMENT_VIEW]` for the "no Enter control" case. */
  permissions?: string[]
  /** Add `EVENT.CROWDED` — a singles event already holding more entrants than a
   * card can list, so entering it puts me past the truncation cut-off. */
  crowded?: boolean
}

interface RecordedRequest {
  method: string
  path: string
}

export class TournamentsStore {
  private detail: TournamentDetailRead
  private entryCounter = 0
  private gate: Promise<void> | null = null

  /** Every intercepted request, for tallies like "exactly one POST landed". */
  readonly requests: RecordedRequest[] = []
  /** Requests this store has no route for. A spec asserts this stays empty — an
   * unmocked call would otherwise fall through to a 404 and be read as an app
   * bug (or, without the catch-all, get `index.html` back from vite). */
  readonly unhandled: RecordedRequest[] = []

  constructor(private readonly options: TournamentsStoreOptions = {}) {
    this.detail = seed(options.crowded ?? false)
  }

  /** The event as the *server* would report it: the `entered` count derived from
   * the live entrants, never stored (ADR-0016). A stub that carried its own
   * counter could drift from its own roster and hide exactly the bug the derived
   * count exists to prevent. */
  private read(event: TournamentEventRead): TournamentEventRead {
    return { ...event, entered: event.entrants.length }
  }

  private readDetail(): TournamentDetailRead {
    return { ...this.detail, events: this.detail.events.map((e) => this.read(e)) }
  }

  /** The active entrants of an event, by event name — for assertions that want
   * the server's view rather than the DOM's. */
  entrantsOf(eventName: string): TournamentEntrantRead[] {
    return this.detail.events.find((e) => e.name === eventName)?.entrants ?? []
  }

  /**
   * Enter **me** into an event *behind this page's back* — the second tab of the
   * two-tab race (#943). No request is recorded, because none came from the page
   * under test: from its point of view the server simply moved on without it, and
   * whatever it is currently rendering is now stale.
   *
   * The next thing that page does with this event (clicking the Enter button it
   * still shows) is therefore a duplicate entry, which the server refuses with a
   * 409 — exactly as `enter()` below does.
   */
  enterElsewhere(eventName: string): TournamentEntrantRead {
    const event = this.detail.events.find((e) => e.name === eventName)
    if (!event) throw new Error(`no such event in the seed: ${eventName}`)
    return this.addEntry(event.id)
  }

  /** Mint one active entry for ME on an event. A fresh entry id each time — as on
   * the server, where re-entry after a withdrawal INSERTs a new row rather than
   * resurrecting the tombstoned one. The withdraw address therefore changes, and
   * a client that cached the old entry id would 404 on the second withdrawal. */
  private addEntry(eventId: string): TournamentEntrantRead {
    this.entryCounter += 1
    const entrant = buildTournamentEntrantRead({
      id: `entry-me-${this.entryCounter}`,
      user_id: ME.userId,
      username: ME.username,
    })
    this.mutateEvent(eventId, (e) => ({ ...e, entrants: [...e.entrants, entrant] }))
    return entrant
  }

  countOf(method: string): number {
    return this.requests.filter((r) => r.method === method).length
  }

  /**
   * Hold every *mutating* response open until the returned callback is invoked —
   * so a spec can look at the UI mid-flight (e.g. "Enter is disabled while the
   * entry is in the air", which is the double-submit guard). Reads keep flowing,
   * so the page still renders.
   */
  holdWrites(): () => void {
    let release!: () => void
    this.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    return () => {
      release()
      this.gate = null
    }
  }

  async install(page: Page) {
    // The client resolves its base URL to `${origin}/api`, so this one glob
    // catches everything the app asks for — session included. Anything NOT
    // routed here would be served `index.html` by the vite dev server and blow
    // up as a JSON parse error somewhere far from its cause.
    await page.route('**/api/v1/**', (route) => this.handle(route))
  }

  private session() {
    return sessionResponse({
      user: {
        username: ME.username,
        permissions: this.options.permissions ?? [
          PERM.TOURNAMENT_VIEW,
          PERM.TOURNAMENT_ENTER,
        ],
      },
    })
  }

  private async handle(route: Route) {
    const request = route.request()
    const method = request.method()
    const path = new URL(request.url()).pathname.replace(/^\/api/, '')
    this.requests.push({ method, path })

    if (path === '/v1/session') {
      return json(route, 200, this.session())
    }
    if (path === '/v1/notifications/unread-count') {
      return json(route, 200, UNREAD_COUNT)
    }

    // Writes wait on the gate (reads never do) — see `holdWrites`.
    if (method !== 'GET' && this.gate) await this.gate

    if (method === 'GET' && path === '/v1/tournaments') {
      return json(route, 200, [this.readDetail()])
    }
    if (method === 'GET' && path === `/v1/tournaments/${TOURNAMENT_ID}`) {
      return json(route, 200, this.readDetail())
    }

    const enter = path.match(/^\/v1\/tournaments\/([^/]+)\/events\/([^/]+)\/entries$/)
    if (method === 'POST' && enter) {
      return this.enter(route, enter[2])
    }

    const withdraw = path.match(
      /^\/v1\/tournaments\/([^/]+)\/events\/([^/]+)\/entries\/([^/]+)$/,
    )
    if (method === 'DELETE' && withdraw) {
      return this.withdraw(route, withdraw[2], withdraw[3])
    }

    this.unhandled.push({ method, path })
    return json(route, 404, { detail: `unmocked ${method} ${path}` })
  }

  /** `POST …/entries` — self-registration. No request body: the caller is always
   * the entrant. Mirrors the API's refusals so the spec cannot pass against a
   * stub more permissive than the server (400 non-singles, 409 duplicate). */
  private async enter(route: Route, eventId: string) {
    const event = this.detail.events.find((e) => e.id === eventId)
    if (!event) return json(route, 404, { detail: 'event not found' })
    if (event.format !== 'singles') {
      return json(route, 400, { detail: 'only singles events can be entered' })
    }
    if (event.entrants.some((e) => e.user_id === ME.userId)) {
      // The server's partial unique index, in miniature: at most one *active*
      // entry per player per event. The API's wording, verbatim — a stale tab
      // gets told this, so the copy is part of the contract under test.
      return json(route, 409, { detail: 'You have already entered this event.' })
    }

    return json(route, 201, this.addEntry(eventId))
  }

  /** `DELETE …/entries/{entry_id}` — withdrawal. The server soft-deletes; from
   * the wire that is indistinguishable from dropping the row, since a withdrawn
   * entry appears in neither the roster nor the count. Withdrawing an entry
   * that is already gone is idempotent (204), exactly as on the server. */
  private async withdraw(route: Route, eventId: string, entryId: string) {
    const event = this.detail.events.find((e) => e.id === eventId)
    if (!event) return json(route, 404, { detail: 'event not found' })

    const entrant = event.entrants.find((e) => e.id === entryId)
    if (!entrant) return noContent(route)
    if (entrant.user_id !== ME.userId) {
      return json(route, 403, { detail: 'not your entry' })
    }

    this.mutateEvent(eventId, (e) => ({
      ...e,
      entrants: e.entrants.filter((x) => x.id !== entryId),
    }))
    return noContent(route)
  }

  private mutateEvent(
    eventId: string,
    fn: (event: TournamentEventRead) => TournamentEventRead,
  ) {
    this.detail = {
      ...this.detail,
      events: this.detail.events.map((e) => (e.id === eventId ? fn(e) : e)),
    }
  }
}

function json(route: Route, status: number, body: unknown) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

function noContent(route: Route) {
  return route.fulfill({ status: 204 })
}
