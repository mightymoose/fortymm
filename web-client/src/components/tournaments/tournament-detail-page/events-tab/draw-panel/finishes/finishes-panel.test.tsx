import { within } from '@/test/utilities'

import {
  buildEvent,
  buildFinishesEvent,
  buildFinishesResults,
  buildFinishRow,
} from '../../../../data/seed.factory'
import { finishesPanelPage as page } from './finishes-panel.page'

/** The player cell (2nd column) of a finish row — where the champion accent lives. */
const playerCellOf = (entryId: string) =>
  within(page.getRow(entryId)).getAllByRole('cell')[1]

describe('FinishesPanel', () => {
  it('renders the placement list, entrants joined to names, ties shown as T{n}', () => {
    // The default: a decided four-entrant bracket — champion 1st, runner-up 2nd, and the two
    // semifinal losers tied 3rd. The list joins each finish's entry id to a name (a list of
    // raw uuids would pass a "renders finishes" check and tell a director nothing) and shows
    // the shared position as a tie, never inventing an order between the two thirds.
    page.render()

    expect(page.getPlacements()).toEqual([
      ['1st', 'player.1'],
      ['2nd', 'player.2'],
      ['T3', 'player.3'],
      ['T3', 'player.4'],
    ])
  })

  it('highlights the champion (position 1) — and names them in the callout', () => {
    page.render()

    const champion = page.queryChampion('ev-single-elim')
    expect(champion).not.toBeNull()
    expect(champion).toHaveTextContent('player.1')

    // The champion's player cell carries the accent treatment; a non-champion's does not.
    expect(playerCellOf('entry-1').className).toContain('ball-500')
    expect(playerCellOf('entry-3').className).not.toContain('ball-500')
  })

  it('shows a partial bracket’s finishes so far, with NO champion callout', () => {
    // A half-played bracket sends only the placements to date; nobody is champion yet. The
    // list renders what the server sent — it never computes a placement — and the callout is
    // absent while `complete` is false.
    page.render({
      event: buildFinishesEvent({
        results: buildFinishesResults({
          complete: false,
          champion: null,
          finishes: [
            buildFinishRow({ entryId: 'entry-3', position: 3, eliminatedInRound: 1 }),
            buildFinishRow({ entryId: 'entry-4', position: 3, eliminatedInRound: 1 }),
          ],
        }),
      }),
    })

    expect(page.queryChampion('ev-single-elim')).toBeNull()
    expect(page.getPlacements()).toEqual([
      ['T3', 'player.3'],
      ['T3', 'player.4'],
    ])
  })

  it('renders NOTHING for an event with no results', () => {
    // An uncut event (and any round-robin one) has no finishes to place — a designed empty
    // state, not an empty table.
    page.render({ event: buildEvent() })

    expect(page.queryPanel('ev-open-singles')).toBeNull()
  })
})
