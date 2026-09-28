import type { components } from '@/api/schema'
import { mockUuid } from '@/mocks/mock-uuid'

export type OpenTournamentCheckoutRead = components['schemas']['OpenTournamentCheckout']

/** One row of `GET /v1/me/checkouts/open`: an active hold with five minutes left. */
export function buildOpenCheckoutRead(
  overrides: Partial<OpenTournamentCheckoutRead> = {},
): OpenTournamentCheckoutRead {
  return {
    checkout_id: mockUuid('open-checkout'),
    tournament_id: mockUuid('open-checkout-tournament'),
    tournament_name: 'Spring Open',
    expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    payment_state: 'ready',
    total_cents: 5_000,
    ...overrides,
  }
}
