import { describe, expect, it } from 'vitest'

import type { components } from '@/api/schema'
import { currentMockCheckout } from './handlers'

type Checkout = components['schemas']['TournamentCheckoutRead']

const checkout: Checkout = {
  id: '00000000-0000-4000-8000-000000000001',
  request_id: '00000000-0000-4000-8000-000000000002',
  tournament_id: '00000000-0000-4000-8000-000000000003',
  registration_generation: 0,
  status: 'active',
  payment_state: 'unavailable',
  currency: 'USD',
  total_cents: 2_000,
  created_at: '2030-04-20T14:00:00Z',
  expires_at: '2030-04-20T14:10:00Z',
  remaining_seconds: 600,
  lines: [],
}

describe('currentMockCheckout', () => {
  it('projects remaining time from the deadline instead of replaying the seed value', () => {
    expect(
      currentMockCheckout(checkout, Date.parse('2030-04-20T14:09:45Z'))
        ?.remaining_seconds,
    ).toBe(15)
  })

  it('removes a checkout once its server-owned deadline passes', () => {
    expect(
      currentMockCheckout(checkout, Date.parse('2030-04-20T14:10:00Z')),
    ).toBeNull()
  })
})
