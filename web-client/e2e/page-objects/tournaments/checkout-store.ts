import type { Page, Route } from '@playwright/test'

import {
  buildTournamentDetailRead,
  buildTournamentEventRead,
} from '../../../src/mocks/factories/tournaments/tournament.factory'
import {
  buildCheckoutRead,
  buildPaymentPrepared,
  buildPaymentRead,
  CHECKOUT_ID,
  CHECKOUT_LINES,
  CHECKOUT_TOURNAMENT_ID,
  OPEN_SINGLES_ID,
  U1500_ID,
  type CheckoutRead,
  type PaymentPrepared,
  type PaymentRead,
} from '../../../src/mocks/factories/checkouts/checkout.factory'
import type { components } from '../../../src/api/schema'
import { sessionResponse } from '../../../src/test/factories'
import { fulfillParkedStream, STREAM_PATH } from '../../support/realtime'

type TournamentDetailRead = components['schemas']['TournamentDetailRead']
type OpenTournamentCheckoutRead = components['schemas']['OpenTournamentCheckout']

/**
 * A stateful Playwright stub for the tournament checkout + payment flow
 * (#1809), through a REAL browser (this suite runs with MSW **off** —
 * `web-client/CLAUDE.md`). Modelled on `checkout-world.ts` (the vitest MSW
 * twin) and built from the same generated-schema-typed factories
 * (`checkout.factory.ts`, `tournament.factory.ts`) — so a change to the
 * OpenAPI contract reds this file at review time rather than passing a stale
 * shape into a green e2e spec. Written independently of the vitest world
 * rather than importing its handlers, the same way `tournaments-store.ts`
 * is independent of `src/mocks/tournaments-store.ts`.
 *
 * A fresh instance per test (never a module singleton): the suite runs
 * `fullyParallel`, and a shared store would let one test's checkout leak
 * into another's.
 */

export const TOURNAMENT_ID = CHECKOUT_TOURNAMENT_ID
export { OPEN_SINGLES_ID, U1500_ID, CHECKOUT_ID }

/** Event names, spelled once so specs never hand-type a string that must
 * agree with the seed. Mirrors `CHECKOUT_LINES`: Open Singles $45, U1500 $30. */
export const EVENT = {
  OPEN_SINGLES: CHECKOUT_LINES[0].event_name,
  U1500: CHECKOUT_LINES[1].event_name,
} as const

export const ME = { username: 'rita.kovac', userId: 'u-checkout-me' } as const

type Reply<T> = T | { status: number; body: unknown }

const isRefusal = (reply: unknown): reply is { status: number; body: unknown } =>
  typeof reply === 'object' &&
  reply !== null &&
  'status' in reply &&
  typeof (reply as { status: unknown }).status === 'number' &&
  'body' in reply

function json(route: Route, status: number, body: unknown) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

function respond(route: Route, reply: Reply<unknown>, okStatus = 200) {
  return isRefusal(reply)
    ? json(route, reply.status, reply.body)
    : json(route, okStatus, reply)
}

/** The next reply from a queue; the last one repeats — so a spec that only
 * cares about the FINAL state can supply a one-element queue. */
function next<T>(queue: T[], served: number): T {
  return queue[Math.min(served, queue.length - 1)]
}

/** Mirrors `isSettled` (`src/components/tournaments/data/payments.ts`) —
 * the client's own rule for "this payment is done, whichever way" — so the
 * stub's idea of settled can never disagree with the app's. */
function isPaymentSettled(payment: PaymentRead): boolean {
  return (
    payment.payment_state === 'succeeded' ||
    payment.payment_state === 'needs_review' ||
    payment.lines.some((line) => line.outcome !== 'pending')
  )
}

export interface CheckoutStoreOptions {
  /** The signed-in player. Defaults to an unconfirmed account (no email on
   * the receipt field) — the same default `sessionUser()` carries. */
  user?: { email?: string | null; confirmed_at?: string | null }
  /** Whether the tournament currently accepts checkouts at all
   * (`checkout_available` / `registration_open` / `status`). Defaults to a
   * published, open, checkout-available tournament — the one state every
   * checkout spec is written against. */
  tournament?: Partial<TournamentDetailRead>
  /** The caller's open checkouts across every tournament, served by
   * `GET /v1/me/checkouts/open` — the app-wide bar's own read. Defaults to
   * empty; a spec about the bar itself supplies rows. */
  openCheckouts?: OpenTournamentCheckoutRead[]
}

export class CheckoutStore {
  private readonly tournament: TournamentDetailRead
  /** The one checkout this store knows about. `current` is what
   * `GET …/checkouts/current` serves (`null` is its 404); `record` is what
   * `GET …/checkouts/{id}` serves regardless of status — the panel keeps
   * showing a checkout after its hold ends or its payment completes, and
   * `?checkout=` can name one long after `current` has moved on. */
  private current: CheckoutRead | null = null
  private record: CheckoutRead | null = null
  /** `undefined` means "build a checkout from the requested event ids" (see
   * `buildCheckoutFor`) — the default, and the only way a spec that picks a
   * NON-default pair of events (e.g. the long-name phone fixture) gets a
   * checkout whose `lines` actually name what it selected, rather than a
   * static fixture's. `setCreateReply` overrides it outright — a refusal, or
   * a specific fixture a spec wants verbatim. */
  private createReply: Reply<CheckoutRead> | undefined = undefined
  private preparedQueue: Reply<PaymentPrepared>[] = [buildPaymentPrepared()]
  private statusQueue: Reply<PaymentRead>[] = [buildPaymentRead()]
  private receiptReply?: Reply<{ receipt_address: string | null }>
  private preparedServed = 0
  private statusServed = 0
  private openCheckouts: OpenTournamentCheckoutRead[]

  /** Every step, in order: `create`, `prepare`, `status`, `receipt`, `cancel`. */
  readonly log: string[] = []
  readonly createdEventIds: string[][] = []
  readonly receiptBodies: unknown[] = []
  /** Requests this store has no route for — a spec asserts this stays empty. */
  readonly unhandled: { method: string; path: string }[] = []
  /** How many times `GET …/checkouts/current` has been read — the app's own
   * 5s discovery poll (`checkoutRefreshInterval`), which is what actually
   * discovers a checkout has settled in THIS suite: production leans on a
   * `checkout.changed` realtime push for near-instant discovery, and this
   * suite's stream is permanently parked (`../../support/realtime`), never
   * MSW's `checkout.changed` event. A spec waits for this count to advance
   * past a captured baseline rather than sleeping a fixed, magic duration. */
  currentReadCount = 0

  constructor(private readonly options: CheckoutStoreOptions = {}) {
    this.tournament = buildTournamentDetailRead({
      id: TOURNAMENT_ID,
      status: 'published',
      registration_open: true,
      checkout_available: true,
      can_edit: false,
      events: [
        buildTournamentEventRead({
          id: OPEN_SINGLES_ID,
          name: EVENT.OPEN_SINGLES,
          entry_fee: CHECKOUT_LINES[0].price_cents / 100,
          max_players: 64,
          reservations: [],
          groups: [],
        }),
        buildTournamentEventRead({
          id: U1500_ID,
          name: EVENT.U1500,
          entry_fee: CHECKOUT_LINES[1].price_cents / 100,
          max_players: 48,
          reservations: [],
          groups: [],
        }),
      ],
      ...options.tournament,
    })
    this.openCheckouts = options.openCheckouts ?? []
  }

  async install(page: Page): Promise<void> {
    await page.route('**/api/v1/**', (route) => this.handle(route))
  }

  private session() {
    return sessionResponse({
      user: {
        username: ME.username,
        email: this.options.user?.email ?? null,
        confirmed_at: this.options.user?.confirmed_at ?? null,
      },
    })
  }

  /** Queue the replies `POST …/checkouts/{id}/payment` serves, in order — the
   * last repeats. */
  setPreparedQueue(queue: Reply<PaymentPrepared>[]): void {
    this.preparedQueue = queue
    this.preparedServed = 0
  }

  /** Queue the replies `GET …/checkouts/{id}/payment` serves, in order — the
   * last repeats. This is the "status-read stub": a spec drives a payment
   * from `checking` to `succeeded` (or to a coded decline) by queuing the
   * sequence the server would actually produce. */
  setStatusQueue(queue: Reply<PaymentRead>[]): void {
    this.statusQueue = queue
    this.statusServed = 0
  }

  /** What `POST …/checkouts` answers — a refusal (`{status, body}`) or a
   * checkout to adopt as `current`. Overrides the default (built from the
   * requested event ids — see `buildCheckoutFor`) outright. */
  setCreateReply(reply: Reply<CheckoutRead>): void {
    this.createReply = reply
  }

  /** The checkout `POST …/checkouts` mints by default: `lines` built from
   * the tournament's OWN events (name and price), for whichever `event_ids`
   * the request actually named — never a static fixture that would drift
   * from a spec's own seed the moment it picked different events. */
  private buildCheckoutFor(eventIds: string[]): CheckoutRead {
    const byId = new Map(this.tournament.events.map((e) => [e.id, e]))
    const lines = eventIds.flatMap((id) => {
      const event = byId.get(id)
      if (!event) return []
      return [
        {
          event_id: event.id,
          event_name: event.name,
          price_cents: Math.round(event.entry_fee * 100),
        },
      ]
    })
    return buildCheckoutRead({
      lines,
      total_cents: lines.reduce((sum, line) => sum + line.price_cents, 0),
    })
  }

  setReceiptReply(reply: Reply<{ receipt_address: string | null }>): void {
    this.receiptReply = reply
  }

  /** Seed an existing checkout — the by-id read a `?checkout=` deep link or a
   * 3-D Secure return resolves against — without going through `create()`.
   * `asCurrent` also seeds it as the ACTIVE hold `GET …/checkouts/current`
   * serves, for a spec that opens the panel via discovery rather than a URL. */
  seedCheckout(checkout: CheckoutRead, { asCurrent = false } = {}): void {
    this.record = checkout
    if (asCurrent) this.current = checkout
  }

  private async handle(route: Route) {
    const request = route.request()
    const method = request.method()
    const path = new URL(request.url()).pathname.replace(/^\/api/, '')

    if (path === '/v1/session') return json(route, 200, this.session())
    if (path === '/v1/notifications/unread-count') {
      return json(route, 200, { unread_count: 0 })
    }
    if (path === STREAM_PATH) return fulfillParkedStream(route)
    if (path === '/v1/me/checkouts/open') {
      return json(route, 200, this.openCheckouts)
    }
    if (method === 'GET' && path === `/v1/tournaments/${TOURNAMENT_ID}`) {
      return json(route, 200, this.tournament)
    }
    if (
      method === 'GET' &&
      path === `/v1/tournaments/${TOURNAMENT_ID}/checkouts/current`
    ) {
      this.currentReadCount += 1
      return this.current
        ? json(route, 200, this.current)
        : json(route, 404, { detail: 'No active checkout.' })
    }
    if (method === 'POST' && path === `/v1/tournaments/${TOURNAMENT_ID}/checkouts`) {
      this.log.push('create')
      const body = request.postDataJSON() as { event_ids?: string[] } | null
      const eventIds = body?.event_ids ?? []
      this.createdEventIds.push(eventIds)
      const reply = this.createReply ?? this.buildCheckoutFor(eventIds)
      if (!isRefusal(reply)) {
        this.current = reply
        this.record = reply
      }
      return respond(route, reply, 201)
    }
    const byId = path.match(
      new RegExp(`^/v1/tournaments/${TOURNAMENT_ID}/checkouts/([^/]+)$`),
    )
    if (method === 'GET' && byId) {
      return json(route, 200, this.record ?? this.current ?? buildCheckoutRead())
    }
    if (method === 'DELETE' && byId) {
      this.log.push('cancel')
      const cancelled: CheckoutRead = {
        ...(this.record ?? this.current ?? buildCheckoutRead()),
        status: 'cancelled',
      }
      this.record = cancelled
      this.current = null
      return json(route, 200, cancelled)
    }
    if (method === 'PATCH' && byId) {
      this.log.push('receipt')
      const body = request.postDataJSON() as { receipt_address: string | null }
      this.receiptBodies.push(body)
      return respond(
        route,
        this.receiptReply ?? { receipt_address: body.receipt_address },
      )
    }
    const payment = path.match(
      new RegExp(`^/v1/tournaments/${TOURNAMENT_ID}/checkouts/([^/]+)/payment$`),
    )
    if (method === 'POST' && payment) {
      this.log.push('prepare')
      const reply = next(this.preparedQueue, this.preparedServed)
      this.preparedServed += 1
      return respond(route, reply, 201)
    }
    if (method === 'GET' && payment) {
      this.log.push('status')
      const reply = next(this.statusQueue, this.statusServed)
      this.statusServed += 1
      // A settled payment (the same rule the client itself uses — `isSettled`,
      // `data/payments.ts`) consumes the checkout: the server marks it
      // `completed` and it drops off `GET …/checkouts/current`, exactly like
      // cancelling does above. Without this a spec's "Done" would re-open the
      // very panel it just closed — the checkout would still read `active`.
      if (!isRefusal(reply) && isPaymentSettled(reply)) {
        this.current = null
        if (this.record) this.record = { ...this.record, status: 'completed' }
      }
      return respond(route, reply)
    }

    this.unhandled.push({ method, path })
    return json(route, 404, { detail: `unmocked ${method} ${path}` })
  }
}
