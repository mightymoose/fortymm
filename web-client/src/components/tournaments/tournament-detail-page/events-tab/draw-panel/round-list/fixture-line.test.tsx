import {
  buildFixtureLineView,
  buildTbdSide,
  buildWithdrawnSide,
} from './fixture-line.factory'
import { fixtureLinePage as page } from './fixture-line.page'

describe('FixtureLine', () => {
  it('reads as a named pairing: "A vs B"', () => {
    page.render({
      fixture: buildFixtureLineView({
        id: 'fx-a-1',
        a: { kind: 'entrant', name: 'player.1' },
        b: { kind: 'entrant', name: 'player.4' },
      }),
    })

    // The NAMES, not the entry ids — a line that printed uuids would still have three
    // children and still pass a "renders a fixture" assertion.
    expect(page.getLineTexts()).toEqual(['player.1 vs player.4'])
  })

  it('renders an undecided side as TBD rather than a blank half-line', () => {
    page.render({
      fixture: buildFixtureLineView({
        id: 'fx-ko-1',
        a: { kind: 'entrant', name: 'player.3' },
        b: buildTbdSide(),
      }),
    })

    expect(page.getLineTexts()).toEqual(['player.3 vs TBD'])
  })

  it('renders a side the event no longer lists as withdrawn — the draw is stale', () => {
    page.render({
      fixture: buildFixtureLineView({
        id: 'fx-a-2',
        a: buildWithdrawnSide(),
        b: { kind: 'entrant', name: 'player.5' },
      }),
    })

    expect(page.getLineTexts()).toEqual(['Withdrawn vs player.5'])
  })

  // A fixture is not a match (CONTEXT.md): there is nothing to click on it until it
  // materializes into one (#788). Nor does it sit under the card's stretched open
  // target as a second, competing control.
  it('is inert — a planned pairing carries no controls', () => {
    page.render({ fixture: buildFixtureLineView({ id: 'fx-a-1' }) })

    expect(page.getControls('fx-a-1')).toHaveLength(0)
  })
})
