import { vi } from 'vitest'
import { http, HttpResponse } from 'msw'

import { server } from '@/mocks/server'

import type { TournamentCheckout } from './api'

const useQueryMock = vi.hoisted(() => vi.fn())

vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQuery: useQueryMock,
}))

import { useCurrentCheckout } from './api'

type CheckoutQueryOptions = {
  enabled: boolean
  queryFn: () => Promise<TournamentCheckout | null>
  refetchInterval: (query: {
    state: { data: TournamentCheckout | null | undefined }
  }) => number | false
}

const terminalCheckout: TournamentCheckout = {
  id: '00000000-0000-4000-8000-000000000001',
  requestId: '00000000-0000-4000-8000-000000000002',
  tournamentId: '00000000-0000-4000-8000-000000000003',
  registrationGeneration: 0,
  status: 'cancelled',
  paymentState: 'canceled',
  currency: 'USD',
  totalCents: 4500,
  createdAt: '2030-04-20T14:00:00Z',
  expiresAt: '2030-04-20T14:10:00Z',
  remainingSeconds: 0,
  lines: [{ eventId: 'event-1', eventName: 'Open Singles', priceCents: 4500 }],
}

function queryOptions(discoveryEnabled: boolean): CheckoutQueryOptions {
  const hook = useCurrentCheckout as unknown as (
    tournamentId: string,
    sessionLoaded: boolean,
    discoveryEnabled: boolean,
  ) => unknown
  hook('00000000-0000-4000-8000-000000000003', true, discoveryEnabled)
  const options = useQueryMock.mock.lastCall?.[0]
  expect(options).toBeDefined()
  return options as CheckoutQueryOptions
}

function interval(
  options: CheckoutQueryOptions,
  checkout: TournamentCheckout | null | undefined,
) {
  return options.refetchInterval({ state: { data: checkout } })
}

describe('current checkout discovery polling', () => {
  beforeEach(() => useQueryMock.mockClear())

  it('keeps discovering after null while another device can create a checkout', () => {
    const options = queryOptions(true)

    expect(options.enabled).toBe(true)
    expect(interval(options, undefined)).toBe(false)
    expect(interval(options, null)).toBe(5_000)
    expect(interval(options, terminalCheckout)).toBe(5_000)
  })

  it('cold-reads once but stops disabled discovery after null or terminal history', () => {
    const options = queryOptions(false)

    expect(options.enabled).toBe(true)
    expect(interval(options, undefined)).toBe(false)
    expect(interval(options, null)).toBe(false)
    expect(interval(options, terminalCheckout)).toBe(false)
    expect(interval(options, { ...terminalCheckout, status: 'active' })).toBe(5_000)
    expect(
      interval(options, {
        ...terminalCheckout,
        status: 'expired',
        paymentState: 'checking',
      }),
    ).toBe(5_000)
  })

  it('anchors server remaining time when the checkout response is mapped', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(12_345)
    server.use(
      http.get('*/v1/tournaments/:tournamentId/checkouts/current', () =>
        HttpResponse.json({
          id: terminalCheckout.id,
          request_id: terminalCheckout.requestId,
          tournament_id: terminalCheckout.tournamentId,
          registration_generation: 0,
          status: 'active',
          payment_state: 'ready',
          currency: 'USD',
          total_cents: 4500,
          created_at: terminalCheckout.createdAt,
          expires_at: terminalCheckout.expiresAt,
          remaining_seconds: 321,
          lines: [
            {
              event_id: '00000000-0000-4000-8000-000000000004',
              event_name: 'Open Singles',
              price_cents: 4500,
            },
          ],
        }),
      ),
    )

    const mapped = await queryOptions(true).queryFn()

    expect(mapped?.remainingSeconds).toBe(321)
    expect(mapped?.remainingSecondsObservedAt).toBe(12_345)
  })
})
