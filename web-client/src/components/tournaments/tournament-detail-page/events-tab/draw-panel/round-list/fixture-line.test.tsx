import {
  buildFixtureLineView,
  buildFixtureMatch,
  buildTbdSide,
  buildWithdrawnSide,
} from './fixture-line.factory'
import { fixtureLinePage as page } from './fixture-line.page'

describe('FixtureLine', () => {
  it('reads as a named pairing: "A vs B"', async () => {
    page.render({
      fixture: buildFixtureLineView({
        id: 'fx-a-1',
        a: { kind: 'entrant', name: 'player.1' },
        b: { kind: 'entrant', name: 'player.4' },
      }),
    })
    await page.findLine('fx-a-1')

    // The NAMES, not the entry ids — a line that printed uuids would still have three
    // children and still pass a "renders a fixture" assertion.
    expect(page.getLineTexts()).toEqual(['player.1 vs player.4'])
  })

  it('renders an undecided side as TBD rather than a blank half-line', async () => {
    page.render({
      fixture: buildFixtureLineView({
        id: 'fx-ko-1',
        a: { kind: 'entrant', name: 'player.3' },
        b: buildTbdSide(),
      }),
    })
    await page.findLine('fx-ko-1')

    expect(page.getLineTexts()).toEqual(['player.3 vs TBD'])
  })

  it('renders a side the event no longer lists as withdrawn — the draw is stale', async () => {
    page.render({
      fixture: buildFixtureLineView({
        id: 'fx-a-2',
        a: buildWithdrawnSide(),
        b: { kind: 'entrant', name: 'player.5' },
      }),
    })
    await page.findLine('fx-a-2')

    expect(page.getLineTexts()).toEqual(['Withdrawn vs player.5'])
  })

  // A *planned* pairing is not a match (CONTEXT.md): there is nothing to click on it
  // until it materializes into one (#788). Nor does it sit under the card's stretched
  // open target as a second, competing control.
  it('is inert while un-materialized — a planned pairing carries no controls', async () => {
    page.render({ fixture: buildFixtureLineView({ id: 'fx-a-1', match: null }) })
    await page.findLine('fx-a-1')

    expect(page.getControls('fx-a-1')).toHaveLength(0)
    expect(page.queryMatchLink('fx-a-1')).toBeNull()
  })

  // The whole point of #788: once a slot has materialized it stops being inert and links
  // to the real match it became, showing that match's live status.
  it('links a materialized slot to its live match and shows the match status', async () => {
    page.render({
      fixture: buildFixtureLineView({
        id: 'fx-a-1',
        a: { kind: 'entrant', name: 'player.1' },
        b: { kind: 'entrant', name: 'player.4' },
        match: buildFixtureMatch({ id: 'm-99', status: 'in_progress' }),
      }),
    })
    await page.findLine('fx-a-1')

    // The pairing still reads as itself — the match affordance is added, not swapped in.
    const link = page.getMatchLink('fx-a-1')
    expect(link).toHaveTextContent('View match')
    // Deep-links the match the slot became — the app's one match route, not a hand-rolled
    // path — so a director opens it and plays it through the normal flow.
    expect(link).toHaveAttribute('href', '/matches/m-99')
    // The status is a real word on the line, not a colour: a director (and a screen
    // reader) learns the match is under way.
    expect(page.getMatchStatus('fx-a-1')).toHaveTextContent('In progress')
    expect(link).toHaveAttribute('aria-label', 'View match — In progress')
  })

  it('shows a completed slot as completed', async () => {
    page.render({
      fixture: buildFixtureLineView({
        id: 'fx-a-1',
        match: buildFixtureMatch({ id: 'm-100', status: 'completed' }),
      }),
    })
    await page.findLine('fx-a-1')

    expect(page.getMatchStatus('fx-a-1')).toHaveTextContent('Completed')
  })
})
