import { interactiveElementsIn } from '@/test/read-only'

import {
  buildMidFlightTwoStageResults,
  buildTwoStageEvent,
} from '../../../../data/seed.factory'
import { twoStagePanelPage as page } from './two-stage-panel.page'

const EVENT_ID = 'ev-two-stage'
const EVENT_NAME = 'Two-stage Singles'

describe('TwoStagePanel', () => {
  it('shows the group standings ABOVE the bracket finishes', () => {
    // The order is the event's own story — groups, then the bracket they seeded. Both
    // sections render either way round, so this reads the DOM order rather than presence.
    page.render()

    expect(page.getStageHeadings()).toEqual(['Standings', 'Finishes'])
    expect(page.queryStandingsPanel(EVENT_ID)).not.toBeNull()
    expect(page.queryFinishesPanel(EVENT_ID)).not.toBeNull()
  })

  it('reuses the shared panels — both groups’ tables and the placement list, joined to names', () => {
    page.render()

    expect(page.getGroupRowNames('Group A')).toEqual([
      'player.5',
      'player.1',
      'player.4',
      'player.8',
    ])
    expect(page.getGroupRowNames('Group B')).toEqual([
      'player.3',
      'player.2',
      'player.6',
      'player.7',
    ])
    expect(page.getPlacements(EVENT_NAME)).toEqual([
      ['1st', 'player.2'],
      ['2nd', 'player.1'],
      ['T3', 'player.5'],
      ['T3', 'player.3'],
    ])
  })

  it('crowns the BRACKET winner in a SINGLE champion banner', () => {
    // `player.2` won the final. `player.5` tops Group A and `player.3` tops Group B — a banner
    // reading the standings would name one of them, and would still look like a champion,
    // which is exactly why this asserts the NAME and not merely that a banner exists.
    page.render()

    const champion = page.queryChampion(EVENT_ID)
    expect(champion).not.toBeNull()
    expect(champion).toHaveTextContent('player.2')
    expect(champion).not.toHaveTextContent('player.5')
    // Exactly one banner on the card: neither stage crowns anybody of its own.
    expect(page.getAllChampions()).toHaveLength(1)
  })

  it('shows NO champion mid-flight — groups decided, the final still to play', () => {
    // The state `ev-shield` is in: both groups complete, the final seated and unplayed. The
    // standings still render in full, the finishes list starts at position 3 (the two beaten
    // semifinalists), and nobody is crowned.
    page.render({
      event: buildTwoStageEvent({ results: buildMidFlightTwoStageResults() }),
    })

    expect(page.queryChampion(EVENT_ID)).toBeNull()
    expect(page.getAllChampions()).toHaveLength(0)
    expect(page.getGroupRowNames('Group A')).toEqual([
      'player.5',
      'player.1',
      'player.4',
      'player.8',
    ])
    expect(page.getPlacements(EVENT_NAME)).toEqual([
      ['T3', 'player.5'],
      ['T3', 'player.3'],
    ])
  })

  it('renders no interactive controls — results are a read-only surface', () => {
    // Nobody edits a result here, owner or not (ADR-0015: a read-only surface puts no
    // control in the tree at all).
    page.render()

    expect(interactiveElementsIn(page.getPanel(EVENT_ID))).toHaveLength(0)
  })
})
