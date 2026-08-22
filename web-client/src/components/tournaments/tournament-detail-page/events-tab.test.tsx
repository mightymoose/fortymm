import userEvent from '@testing-library/user-event'
import { HttpResponse } from 'msw'

import { mockEventEnterEndpoint } from '@/mocks/endpoints/tournaments/tournaments.endpoint'
import { buildTournamentEntrantRead } from '@/mocks/factories/tournaments/tournament.factory'
import { server } from '@/mocks/server'
import { screen, waitFor } from '@/test/utilities'

import {
  buildDrawnEvent,
  buildTournament,
  buildEntrant,
  buildEntrants,
  buildEvent,
  groupIdFor,
} from '../data/seed.factory'
import { eventsTabPage } from './events-tab.page'

describe('EventsTab', () => {
  it('opens an event from its card', async () => {
    const onOpenEvent = vi.fn()
    eventsTabPage.render({
      tournament: buildTournament({ events: [buildEvent({ name: 'Open Singles' })] }),
      onOpenEvent,
    })
    await userEvent.click(eventsTabPage.getOpenButton('Open Singles'))
    expect(onOpenEvent).toHaveBeenCalledTimes(1)
  })

  it('shows the empty state and creates a first event', async () => {
    const onNewEvent = vi.fn()
    eventsTabPage.render({
      tournament: buildTournament({ events: [] }),
      onNewEvent,
    })
    expect(document.body).toHaveTextContent('No events yet')
    await userEvent.click(eventsTabPage.getNewEventButton())
    expect(onNewEvent).toHaveBeenCalledTimes(1)
  })

  it('hides every "new event" affordance for a non-creator', () => {
    eventsTabPage.render({
      tournament: buildTournament({ events: [buildEvent()] }),
      canEdit: false,
    })
    expect(eventsTabPage.queryNewEventButtons()).toHaveLength(0)
  })

  it('hides the empty-state CTA for a non-creator', () => {
    eventsTabPage.render({
      tournament: buildTournament({ events: [] }),
      canEdit: false,
    })
    expect(document.body).toHaveTextContent('No events yet')
    expect(eventsTabPage.queryNewEventButtons()).toHaveLength(0)
  })

  // The default MSW session is `rita.kovac`, a beta tester holding
  // `tournament.enter` — and she is not among the seeded entrants.
  describe('the self-registration control on each card', () => {
    it('offers Enter on a singles event', async () => {
      eventsTabPage.render({
        tournament: buildTournament({
          events: [buildEvent({ name: 'Open Singles' })],
        }),
      })

      expect(
        await eventsTabPage.findEnterButton('Open Singles'),
      ).toBeInTheDocument()
    })

    it('offers none on a doubles event', async () => {
      eventsTabPage.render({
        tournament: buildTournament({
          events: [
            buildEvent({ name: 'Open Singles' }),
            buildEvent({
              id: 'ev-open-doubles',
              name: 'Open Doubles',
              format: 'doubles',
            }),
          ],
        }),
      })

      // The singles card's control is the gate: once it is on screen the
      // session has landed, so the doubles card's absence is a real absence.
      await eventsTabPage.findEnterButton('Open Singles')
      expect(eventsTabPage.queryEnterButton('Open Doubles')).toBeNull()
    })

    it('enters the event on click — and does NOT open the editor', async () => {
      let entered = 0
      mockEventEnterEndpoint(server, () => {
        entered += 1
        return HttpResponse.json(buildTournamentEntrantRead(), { status: 201 })
      })
      const onOpenEvent = vi.fn()
      eventsTabPage.render({
        tournament: buildTournament({
          id: 't-1',
          events: [buildEvent({ name: 'Open Singles' })],
        }),
        onOpenEvent,
      })

      await userEvent.click(await eventsTabPage.findEnterButton('Open Singles'))

      await waitFor(() => expect(entered).toBe(1))
      // Handler wiring only. jsdom has no layout or paint, so this passes
      // regardless of z-index — the control's click-isolation from the card's
      // stretched open-overlay is only truly asserted in the browser (2e).
      expect(onOpenEvent).not.toHaveBeenCalled()
    })

    // The seam this merge creates. ADR 0015 says a non-owner gets a *rendering,
    // not controls* — and its guards assert zero interactive controls in the
    // editor panels. Entering is not one of those controls: it is a PLAYER
    // affordance gated on `tournament.enter`, not an OWNER one gated on
    // `canEdit`, and self-registration is by definition something you do to
    // someone else's tournament. So the non-owner who gets the read-only view
    // must still get Enter. (`EnterEventControl` never reads `canEdit`; this
    // pins that it never starts to.)
    it('still offers Enter to a non-owner, who gets the read-only view', async () => {
      eventsTabPage.render({
        tournament: buildTournament({
          events: [buildEvent({ name: 'Open Singles' })],
        }),
        canEdit: false,
      })

      expect(
        await eventsTabPage.findEnterButton('Open Singles'),
      ).toBeInTheDocument()
      // The card opens a read-only view, not an editor — ADR 0015 still holds
      // around the control.
      expect(
        eventsTabPage.getOpenButton('Open Singles', 'View'),
      ).toBeInTheDocument()
      expect(eventsTabPage.queryNewEventButtons()).toHaveLength(0)
    })
  })

  // The tab is where the session is READ (one query, every card): the roster's
  // "which entrant is me" join is only as good as the username that reaches it.
  it('tells every card who the viewer is, so they see themselves in a busy roster', async () => {
    // The 52-entrant Open Singles with the default MSW session's player
    // (`rita.kovac`) entered LAST — the exact shape of #781, where the card
    // showed the first 8 and left her looking for herself in vain.
    eventsTabPage.render({
      tournament: buildTournament({
        events: [
          buildEvent({
            name: 'Open Singles',
            entrants: [
              ...buildEntrants(52),
              buildEntrant({
                id: 'entry-me',
                userId: 'u-me',
                username: 'rita.kovac',
              }),
            ],
          }),
        ],
      }),
    })

    // `find`, not `query`: the username arrives with the session.
    expect(
      await eventsTabPage.findEntrant('Open Singles', 'rita.kovac'),
    ).toBeInTheDocument()
    expect(
      eventsTabPage.queryTruncationTail('Open Singles'),
    ).toHaveTextContent('+45 more')
  })

  // Clicking a card opens the editor for the organizer and a read-only view for
  // everyone else, so the subtitle promises what the click delivers (ADR 0015,
  // rule 5). Asserted both ways: the discriminating word is the verb.
  describe('the "click any event" subtitle', () => {
    it('invites the creator to edit', () => {
      eventsTabPage.render({ tournament: buildTournament() })
      expect(screen.getByText(/Click any event to edit\./)).toBeInTheDocument()
      expect(screen.queryByText(/Click any event for details\./)).toBeNull()
    })

    it('offers a non-creator details, not editing', () => {
      eventsTabPage.render({ tournament: buildTournament(), canEdit: false })
      expect(
        screen.getByText(/Click any event for details\./),
      ).toBeInTheDocument()
      expect(screen.queryByText(/Click any event to edit\./)).toBeNull()
    })
  })

  // The draw hangs off the EVENT (ADR-0786) — there is no Draw tab, because a draw
  // belongs to one event and a tab would have to ask which. Wiring only: the panel's own
  // quartet pins the groups, the rounds, the refusals and the empty state.
  describe('the draw on each card', () => {
    it('gives every event its own draw panel, fed that event’s tournament', async () => {
      eventsTabPage.render({
        tournament: buildTournament({
          id: 't-1',
          events: [buildDrawnEvent(), buildEvent({ id: 'ev-open-singles' })],
        }),
      })

      // The drawn event expands into its groups…
      expect(eventsTabPage.getGroupLines(groupIdFor('res-a'))).toEqual([
        'player.1 vs player.4',
        'player.1 vs player.5',
        'player.4 vs player.5',
      ])
      // …and the undrawn one shows its designed empty state, not a gap.
      expect(eventsTabPage.queryPanel('ev-open-singles')).toBeInTheDocument()
      expect(eventsTabPage.getEmptyState()).toHaveTextContent('No draw yet.')
    })

    it('gates the draw verbs on the tournament’s canEdit, like every other owner action', () => {
      const tournament = buildTournament({ events: [buildDrawnEvent()] })

      eventsTabPage.render({ tournament, canEdit: false })

      expect(eventsTabPage.queryRecutButton('U1200 Singles')).toBeNull()
      expect(eventsTabPage.queryDeleteButton('U1200 Singles')).toBeNull()
      expect(eventsTabPage.getPanelControls('ev-u1200')).toHaveLength(0)
    })

    it('offers the creator the draw verbs on the card itself', () => {
      eventsTabPage.render({
        tournament: buildTournament({ events: [buildDrawnEvent()] }),
        canEdit: true,
      })

      expect(eventsTabPage.queryRecutButton('U1200 Singles')).toBeInTheDocument()
      expect(eventsTabPage.queryDeleteButton('U1200 Singles')).toBeInTheDocument()
    })
  })
})
