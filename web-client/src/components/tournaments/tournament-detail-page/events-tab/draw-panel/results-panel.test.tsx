import { buildEvent, buildFinishesEvent } from '../../../data/seed.factory'
import { resultsPanelPage as page } from './results-panel.page'

describe('ResultsPanel', () => {
  it('renders the standings table for a round-robin (kind: standings) — regression', () => {
    // The default event carries `standings` results; the switch must still route to the
    // standings table exactly as before the union landed.
    page.render()

    expect(page.queryStandingsPanel('ev-u1200')).not.toBeNull()
    expect(page.queryFinishesPanel('ev-u1200')).toBeNull()
  })

  it('renders the finishes list for a single-elimination event (kind: finishes)', () => {
    page.render({ event: buildFinishesEvent() })

    expect(page.queryFinishesPanel('ev-single-elim')).not.toBeNull()
    expect(page.queryStandingsPanel('ev-single-elim')).toBeNull()
  })

  it('renders nothing for an event with no results', () => {
    page.render({ event: buildEvent() })

    expect(page.queryStandingsPanel('ev-open-singles')).toBeNull()
    expect(page.queryFinishesPanel('ev-open-singles')).toBeNull()
  })
})
