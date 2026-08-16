import { userEvent } from '@testing-library/user-event'
import {
  buildTournamentPanelView,
  buildTournamentTabView,
} from './tournament-panel.factory'
import { tournamentPanelPage } from './tournament-panel.page'

describe('TournamentPanel', () => {
  it('names the tournament and its venue', async () => {
    tournamentPanelPage.render()

    await tournamentPanelPage.findHeading('Riverside Summer Slam')
    expect(tournamentPanelPage.queryPanel()).toHaveTextContent(
      'Riverside TTC · Jul 24–25',
    )
  })

  it('links out to the tournament page', async () => {
    tournamentPanelPage.render()

    await tournamentPanelPage.findHeading('Riverside Summer Slam')
    expect(
      tournamentPanelPage.getDestinationLink(/view group & standings/i),
    ).toHaveAttribute('href', '/tournaments/t-1')
  })

  it('counts the viewer’s live matches in the header', async () => {
    tournamentPanelPage.render({
      view: buildTournamentPanelView({ liveLabel: '2 live now' }),
    })

    await tournamentPanelPage.findHeading('Riverside Summer Slam')
    expect(tournamentPanelPage.queryLiveBadge()).toHaveTextContent('2 live now')
  })

  it('hides the live pill when nothing of the viewer’s is being played', async () => {
    tournamentPanelPage.render({
      view: buildTournamentPanelView({ liveLabel: null }),
    })

    await tournamentPanelPage.findHeading('Riverside Summer Slam')
    expect(tournamentPanelPage.queryLiveBadge()).toBeNull()
  })

  it('renders one tab per entered event', async () => {
    tournamentPanelPage.render({
      view: buildTournamentPanelView({
        tabs: [
          buildTournamentTabView({ eventId: 'e-1', name: 'Open Singles' }),
          buildTournamentTabView({ eventId: 'e-2', name: 'U1500' }),
        ],
      }),
    })

    await tournamentPanelPage.findHeading('Riverside Summer Slam')
    expect(tournamentPanelPage.getTabs().map((tab) => tab.textContent)).toEqual([
      expect.stringContaining('Open Singles'),
      expect.stringContaining('U1500'),
    ])
  })

  it('marks the event holding a live match', async () => {
    tournamentPanelPage.render({
      view: buildTournamentPanelView({
        tabs: [
          buildTournamentTabView({ eventId: 'e-1', name: 'Open Singles', live: false }),
          buildTournamentTabView({ eventId: 'e-2', name: 'U1500', live: true }),
        ],
      }),
    })

    await tournamentPanelPage.findHeading('Riverside Summer Slam')
    expect(tournamentPanelPage.getTab(/open singles/i)).not.toHaveTextContent(
      'Live',
    )
    expect(tournamentPanelPage.getTab(/u1500/i)).toHaveTextContent('Live')
  })

  it('shows the first event until another tab is chosen', async () => {
    tournamentPanelPage.render({
      view: buildTournamentPanelView({
        tabs: [
          buildTournamentTabView({
            eventId: 'e-1',
            name: 'Open Singles',
            pathSubheading: 'Group A · 4 players',
          }),
          buildTournamentTabView({
            eventId: 'e-2',
            name: 'U1500',
            pathSubheading: 'Group B · 6 players',
          }),
        ],
      }),
    })

    await tournamentPanelPage.findHeading('Riverside Summer Slam')
    expect(tournamentPanelPage.getActivePanel()).toHaveTextContent(
      'Group A · 4 players',
    )

    await userEvent.click(tournamentPanelPage.getTab(/u1500/i))

    expect(tournamentPanelPage.getActivePanel()).toHaveTextContent(
      'Group B · 6 players',
    )
  })

  it('wires the active tab’s match, stats and schedule in', async () => {
    // Wiring only: each child's content is pinned by its own quartet.
    tournamentPanelPage.render()

    await tournamentPanelPage.findHeading('Riverside Summer Slam')
    expect(tournamentPanelPage.matchCard.queryCard()).not.toBeNull()
    expect(tournamentPanelPage.stats.queryStrip()).not.toBeNull()
    expect(tournamentPanelPage.path.getRows()).toHaveLength(3)
  })

  it('explains an event whose draw has not been made instead of showing an empty card', async () => {
    tournamentPanelPage.render({
      view: buildTournamentPanelView({
        tabs: [buildTournamentTabView({ match: null, path: [] })],
      }),
    })

    await tournamentPanelPage.findHeading('Riverside Summer Slam')
    expect(tournamentPanelPage.matchCard.queryCard()).toBeNull()
    expect(tournamentPanelPage.queryNoMatchNotice()).toHaveTextContent(
      /draw for this event hasn’t been made yet/i,
    )
    // The stats strip stays — the record and stage are meaningful before a draw.
    expect(tournamentPanelPage.stats.queryStrip()).not.toBeNull()
  })
})
