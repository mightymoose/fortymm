import {
  buildUnscheduledFixture,
  buildUnscheduledRailProps,
} from './unscheduled-rail.factory'
import { unscheduledRailPage as page } from './unscheduled-rail.page'

describe('UnscheduledRail', () => {
  it('lists an unplaced fixture with its pairing and event · group', () => {
    page.render()
    expect(page.getItemTexts()).toEqual([
      'player.2 vs player.3U1200 Singles · Group B',
    ])
  })

  it('names the table of a half-placement — a table with no time yet', () => {
    page.render(
      buildUnscheduledRailProps({
        items: [buildUnscheduledFixture({ tableLabel: 'T2' })],
      }),
    )
    expect(page.getItem('fx-b-1')).toHaveTextContent('T2, no time yet')
  })

  it('counts its items', () => {
    page.render({
      items: [
        buildUnscheduledFixture(),
        buildUnscheduledFixture({ fixtureId: 'fx-b-2' }),
      ],
    })
    expect(page.getRail()).toHaveTextContent('Not yet scheduled')
    expect(page.getRail()).toHaveTextContent('2')
  })

  it('renders nothing at all when everything is placed', () => {
    page.render({ items: [] })
    expect(page.queryRail()).not.toBeInTheDocument()
  })
})
