import { describe, expect, it } from 'vitest'

import type { components } from '@/api/schema'
import {
  cancelMockCheckout,
  currentMockCheckout,
  findTournament,
  readCurrentMockCheckout,
  resetTournamentsStore,
  storeMockCheckout,
  updateEvent,
} from './tournaments-store'
import { BAY_AREA_OPEN_ID } from './factories/tournaments/tournament-ids'
import { mockUuid } from './mock-uuid'

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

describe('mock checkout capacity projection', () => {
  const eventId = mockUuid('ev-open-singles')

  beforeEach(() => resetTournamentsStore())

  it('projects active holds into tournament capacity and releases them on cancellation', () => {
    const original = findTournament(BAY_AREA_OPEN_ID)!.events.find(
      (event) => event.id === eventId,
    )!
    const resized = updateEvent(BAY_AREA_OPEN_ID, eventId, {
      lock_version: original.lock_version,
      max_players: original.entered + 1,
    })
    expect(resized.ok).toBe(true)
    const before = findTournament(BAY_AREA_OPEN_ID)!.events.find(
      (event) => event.id === eventId,
    )!
    const heldCheckout = {
      ...checkout,
      tournament_id: BAY_AREA_OPEN_ID,
      expires_at: new Date(Date.now() + 600_000).toISOString(),
      lines: [{ event_id: eventId, event_name: before.name, price_cents: 4_500 }],
    }
    storeMockCheckout(heldCheckout)

    const held = findTournament(BAY_AREA_OPEN_ID)!.events.find(
      (event) => event.id === eventId,
    )!
    expect(held.held_places).toBe(1)
    expect(held.available_places).toBe(0)
    expect(held.entry_state).toEqual({ state: 'event_full' })

    expect(cancelMockCheckout(BAY_AREA_OPEN_ID, heldCheckout.id)?.status).toBe(
      'cancelled',
    )
    const released = findTournament(BAY_AREA_OPEN_ID)!.events.find(
      (event) => event.id === eventId,
    )!
    expect(released.held_places).toBe(0)
    expect(released.available_places).toBe(before.available_places)
    expect(released.entry_state).toEqual({ state: 'open' })
  })

  it('drops expired holds from tournament reads', () => {
    storeMockCheckout({
      ...checkout,
      tournament_id: BAY_AREA_OPEN_ID,
      expires_at: new Date(Date.now() - 1).toISOString(),
      lines: [{ event_id: eventId, event_name: 'Open Singles', price_cents: 4_500 }],
    })

    const event = findTournament(BAY_AREA_OPEN_ID)!.events.find(
      (candidate) => candidate.id === eventId,
    )!
    expect(event.held_places).toBe(0)
  })
})

describe('POST /v1/tournaments/:tournamentId/checkouts', () => {
  const eventId = mockUuid('ev-open-singles')

  beforeEach(() => resetTournamentsStore())

  it('preserves the first active checkout and rejects a second request id', async () => {
    const url = `http://localhost/v1/tournaments/${BAY_AREA_OPEN_ID}/checkouts`
    const first = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        request_id: '00000000-0000-4000-8000-000000000010',
        event_ids: [eventId],
      }),
    })
    expect(first.status).toBe(201)
    const created = await first.json() as Checkout

    const second = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        request_id: '00000000-0000-4000-8000-000000000011',
        event_ids: [eventId],
      }),
    })
    expect(second.status).toBe(409)
    await expect(second.json()).resolves.toEqual({
      detail: {
        code: 'active_checkout_conflict',
        message: 'Cancel the active checkout before changing the event selection.',
      },
    })
    expect(readCurrentMockCheckout(BAY_AREA_OPEN_ID)?.id).toBe(created.id)
  })
})
