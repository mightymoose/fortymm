import userEvent from '@testing-library/user-event'
import { delay, HttpResponse } from 'msw'

import {
  mockEventEnterEndpoint,
  mockEventWithdrawEndpoint,
} from '@/mocks/endpoints/tournaments/tournaments.endpoint'
import { buildTournamentEntrantRead } from '@/mocks/factories/tournaments/tournament.factory'
import { server } from '@/mocks/server'
import { PERM } from '@/lib/permissions'
import { waitFor } from '@/test/utilities'

import { buildEntrant, buildEvent } from '../../data/seed.factory'
import {
  enterEventControlPage as page,
  SIGNED_IN_USERNAME,
} from './enter-event-control.page'

/** The seeded Open Singles event with the signed-in player in it — entry
 * `entry-me`, alongside a couple of other players' entries (whose ids the
 * withdrawal must never pick up). */
const enteredEvent = buildEvent({
  name: 'Open Singles',
  entrants: [
    buildEntrant({ id: 'entry-1', userId: 'u-1', username: 'player.1' }),
    buildEntrant({
      id: 'entry-me',
      userId: 'u-me',
      username: SIGNED_IN_USERNAME,
    }),
    buildEntrant({ id: 'entry-2', userId: 'u-2', username: 'player.2' }),
  ],
})

describe('EnterEventControl', () => {
  it('offers Enter to a permitted player who is not in the event', async () => {
    page.render({ event: buildEvent({ name: 'Open Singles' }) })

    expect(await page.findEnterButton('Open Singles')).toBeInTheDocument()
    expect(page.queryWithdrawButton('Open Singles')).toBeNull()
  })

  it('offers Withdraw once that player is one of the entrants', async () => {
    page.render({ event: enteredEvent })

    expect(await page.findWithdrawButton('Open Singles')).toBeInTheDocument()
    expect(page.queryEnterButton('Open Singles')).toBeNull()
  })

  it('offers nothing to a player without tournament.enter — absent, not disabled', async () => {
    page.render(
      { event: buildEvent({ name: 'Open Singles' }) },
      { permissions: [PERM.TOURNAMENT_VIEW] },
    )

    // The session must have LANDED before "there is no button" means anything:
    // permissions read as absent while it is still in flight.
    await page.findSessionReady()

    expect(page.queryEnterButton('Open Singles')).toBeNull()
    expect(page.queryWithdrawButton('Open Singles')).toBeNull()
  })

  it('offers nothing on a doubles event, even to a permitted player', async () => {
    page.render({
      event: buildEvent({ name: 'Open Doubles', format: 'doubles' }),
    })

    await page.findSessionReady()

    expect(page.queryEnterButton('Open Doubles')).toBeNull()
    expect(page.queryWithdrawButton('Open Doubles')).toBeNull()
  })

  it('offers nothing on a teams event, even to a permitted player', async () => {
    page.render({
      event: buildEvent({ name: 'Club Teams', format: 'teams' }),
    })

    await page.findSessionReady()

    expect(page.queryEnterButton('Club Teams')).toBeNull()
    expect(page.queryWithdrawButton('Club Teams')).toBeNull()
  })

  it('enters THIS event when Enter is clicked', async () => {
    let seenUrl = ''
    mockEventEnterEndpoint(server, ({ request }) => {
      seenUrl = request.url
      return HttpResponse.json(buildTournamentEntrantRead(), { status: 201 })
    })
    page.render({
      tournamentId: 't-1',
      event: buildEvent({ id: 'ev-u1500', name: 'U1500 Singles' }),
    })

    await userEvent.click(await page.findEnterButton('U1500 Singles'))

    await waitFor(() =>
      expect(seenUrl).toContain('/v1/tournaments/t-1/events/ev-u1500/entries'),
    )
  })

  it("withdraws the player's OWN entry when Withdraw is clicked", async () => {
    let seenUrl = ''
    mockEventWithdrawEndpoint(server, ({ request }) => {
      seenUrl = request.url
      return new HttpResponse(null, { status: 204 })
    })
    page.render({ tournamentId: 't-1', event: enteredEvent })

    await userEvent.click(await page.findWithdrawButton('Open Singles'))

    // `entry-me`, not `entry-1`/`entry-2` — an entry is addressed by ITS id, and
    // the player's own is found by joining on their username.
    await waitFor(() =>
      expect(seenUrl).toContain(
        `/v1/tournaments/t-1/events/${enteredEvent.id}/entries/entry-me`,
      ),
    )
  })

  it('enters once, not twice, when Enter is double-clicked', async () => {
    let calls = 0
    mockEventEnterEndpoint(server, async () => {
      calls += 1
      // Hold the request open so the second click lands while the first is
      // still in flight — the exact race the guard exists for.
      await delay('infinite')
      return HttpResponse.json(buildTournamentEntrantRead(), { status: 201 })
    })
    page.render({ event: buildEvent({ name: 'Open Singles' }) })
    const enter = await page.findEnterButton('Open Singles')

    await userEvent.click(enter)
    await userEvent.click(enter)

    expect(calls).toBe(1)
    // ...because the control locks itself while the entry is in flight.
    expect(enter).toBeDisabled()
  })
})
