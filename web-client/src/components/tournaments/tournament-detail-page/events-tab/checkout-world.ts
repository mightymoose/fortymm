import { delay, http, HttpResponse } from 'msw'

import {
  buildCheckoutRead,
  buildPaymentPrepared,
  buildPaymentRead,
  type CheckoutRead,
  type PaymentPrepared,
  type PaymentRead,
} from '@/mocks/factories/checkouts/checkout.factory'
import { server } from '@/mocks/server'

type Reply<T> = T | { status: number; body: unknown }

const isRefusal = (reply: unknown): reply is { status: number; body: unknown } =>
  typeof reply === 'object' &&
  reply !== null &&
  'status' in reply &&
  typeof (reply as { status: unknown }).status === 'number' &&
  'body' in reply

function respond<T>(reply: Reply<T>, okStatus = 200) {
  return isRefusal(reply)
    ? HttpResponse.json(reply.body as never, { status: reply.status })
    : HttpResponse.json(reply as never, { status: okStatus })
}

/** The next reply from a queue; the last one repeats. */
const next = <T>(queue: T[], served: number) =>
  queue[Math.min(served, queue.length - 1)]

/**
 * An in-memory checkout and payment API for the Events tab's checkout tests.
 * Each test sets the state it needs, then reads the recorded calls. `current`
 * is what `GET .../checkouts/current` serves (`null` is its 404). `checkout`
 * is what `GET .../checkouts/{id}` serves. `prepared` and `status` are reply
 * queues for the payment's prepare and status reads.
 */
export function mockCheckoutWorld(initial: {
  current?: CheckoutRead | null
  /** `null` makes the by-id read a 404: a checkout that is gone, or not yours. */
  checkout?: CheckoutRead | null
  /** Hold every status read this long, to see what shows while it loads. */
  statusDelayMs?: number
  /** Refuse every DELETE with this reply (e.g. a transient 503). */
  cancelRefusal?: { status: number; body: unknown }
  created?: Reply<CheckoutRead>
  prepared?: Reply<PaymentPrepared>[]
  status?: Reply<PaymentRead>[]
  receipt?: Reply<{ receipt_address: string | null }>
} = {}) {
  const world = {
    current: initial.current ?? null,
    checkout: initial.checkout === undefined ? buildCheckoutRead() : initial.checkout,
    created: initial.created ?? buildCheckoutRead(),
    prepared: initial.prepared ?? [buildPaymentPrepared()],
    status: initial.status ?? [buildPaymentRead()],
    receipt: initial.receipt,
    calls: {
      /** Every step, in order: `create`, `prepare`, `status`, `receipt`, `cancel`. */
      log: [] as string[],
      createdEventIds: [] as string[][],
      receiptBodies: [] as unknown[],
      prepare: 0,
      status: 0,
    },
  }
  server.use(
    http.get('*/v1/tournaments/:tournamentId/checkouts/current', () => {
      if (!world.current) {
        return HttpResponse.json({ detail: 'No active checkout.' }, { status: 404 })
      }
      return HttpResponse.json(world.current)
    }),
    http.post('*/v1/tournaments/:tournamentId/checkouts', async ({ request }) => {
      const body = (await request.json()) as { event_ids: string[] }
      world.calls.log.push('create')
      world.calls.createdEventIds.push(body.event_ids)
      if (!isRefusal(world.created)) {
        world.current = world.created
        world.checkout = world.created
      }
      return respond(world.created, 201)
    }),
    http.get('*/v1/tournaments/:tournamentId/checkouts/:checkoutId', () =>
      world.checkout
        ? HttpResponse.json(world.checkout)
        : HttpResponse.json({ detail: 'Checkout not found.' }, { status: 404 }),
    ),
    http.delete('*/v1/tournaments/:tournamentId/checkouts/:checkoutId', () => {
      world.calls.log.push('cancel')
      if (initial.cancelRefusal) {
        return HttpResponse.json(initial.cancelRefusal.body as never, {
          status: initial.cancelRefusal.status,
        })
      }
      world.checkout = { ...(world.checkout ?? buildCheckoutRead()), status: 'cancelled' }
      world.current = null
      return HttpResponse.json(world.checkout)
    }),
    http.patch(
      '*/v1/tournaments/:tournamentId/checkouts/:checkoutId',
      async ({ request }) => {
        const body = (await request.json()) as { receipt_address: string | null }
        world.calls.log.push('receipt')
        world.calls.receiptBodies.push(body)
        return respond(world.receipt ?? { receipt_address: body.receipt_address })
      },
    ),
    http.post(
      '*/v1/tournaments/:tournamentId/checkouts/:checkoutId/payment',
      () => {
        world.calls.log.push('prepare')
        const reply = next(world.prepared, world.calls.prepare)
        world.calls.prepare += 1
        return respond(reply, 201)
      },
    ),
    http.get(
      '*/v1/tournaments/:tournamentId/checkouts/:checkoutId/payment',
      async () => {
        if (initial.statusDelayMs) await delay(initial.statusDelayMs)
        world.calls.log.push('status')
        const reply = next(world.status, world.calls.status)
        world.calls.status += 1
        return respond(reply)
      },
    ),
  )
  return world
}
