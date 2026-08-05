import {
  buildEvent,
  buildFinishesEvent,
  buildMidFlightTwoStageResults,
  buildSwissStandingsEvent,
  buildSwissStandingsResults,
  buildTwoStageEvent,
} from '../../../data/seed.factory'
import { resultsPanelPage as page } from './results-panel.page'

describe('ResultsPanel', () => {
  it('renders the standings table for a round-robin (kind: standings) — regression', () => {
    // The default event carries `standings` results; the switch must still route to the
    // standings table exactly as before the union landed.
    page.render()

    expect(page.queryStandingsPanel('ev-u1200')).not.toBeNull()
    expect(page.queryFinishesPanel('ev-u1200')).toBeNull()
    // The panel is handed its data now, so this is where the wiring is checked: the event's
    // OWN standings (champion `entry-1`, joined to a name) reached it, and its own pool.
    expect(page.getChampion('standings-champion-ev-u1200')).toHaveTextContent(
      'player.1',
    )
    expect(page.getTableName()).toBe('Standings for Pool A')
  })

  it('renders the finishes list for a single-elimination event (kind: finishes)', () => {
    page.render({ event: buildFinishesEvent() })

    expect(page.queryFinishesPanel('ev-single-elim')).not.toBeNull()
    expect(page.queryStandingsPanel('ev-single-elim')).toBeNull()
    // Same wiring check for the finishes arm — and the table's accessible name is the only
    // proof that the event's NAME was threaded through to a panel that no longer reads it.
    expect(page.getChampion('finishes-champion-ev-single-elim')).toHaveTextContent(
      'player.1',
    )
    expect(page.getTableName()).toBe('Finishes for Championship Singles')
  })

  it('renders BOTH stages for a two-stage event (kind: standings_then_finishes)', () => {
    // The third arm (ADR 20260727) routes to the composite, which reuses the same two
    // panels — so a two-stage card shows a standings block AND a finishes block, under one
    // champion banner naming the BRACKET's winner (`player.2`), who tops neither pool.
    page.render({ event: buildTwoStageEvent() })

    expect(page.queryStandingsPanel('ev-two-stage')).not.toBeNull()
    expect(page.queryFinishesPanel('ev-two-stage')).not.toBeNull()
    expect(page.getChampion('two-stage-champion-ev-two-stage')).toHaveTextContent(
      'player.2',
    )
    // Neither stage crowned anybody itself — one banner on the card, not three.
    expect(page.queryStandingsChampion('ev-two-stage')).toBeNull()
    expect(page.queryFinishesChampion('ev-two-stage')).toBeNull()
  })

  it('renders a mid-flight two-stage event with no champion at all', () => {
    // Pools decided, final unplayed: the stages still render, and nothing is crowned.
    page.render({
      event: buildTwoStageEvent({ results: buildMidFlightTwoStageResults() }),
    })

    expect(page.queryStandingsPanel('ev-two-stage')).not.toBeNull()
    expect(page.queryFinishesPanel('ev-two-stage')).not.toBeNull()
    expect(page.queryTwoStageChampion('ev-two-stage')).toBeNull()
  })

  it('renders ONE pool-less table for a swiss event (kind: swiss_standings)', () => {
    // The fourth arm (the swiss ADR) routes to the pool-less panel. It is neither of the
    // pooled blocks — a `standings-panel-…` here would mean a swiss event was routed into
    // the arm that groups by pool, which for a format with no pools renders nothing at all.
    page.render({ event: buildSwissStandingsEvent() })

    expect(page.querySwissPanel('ev-swiss')).not.toBeNull()
    expect(page.queryStandingsPanel('ev-swiss')).toBeNull()
    expect(page.queryFinishesPanel('ev-swiss')).toBeNull()
    // The wiring check: the event's OWN standings (champion `entry-1`, joined to a name)
    // reached the panel, and the table's accessible name is the only proof that the event's
    // NAME was threaded through to a panel that does not read the event.
    expect(page.getChampion('swiss-champion-ev-swiss')).toHaveTextContent('player.1')
    expect(page.getTableName()).toBe('Standings for Swiss Singles')
  })

  it('renders a live swiss event with no champion at all', () => {
    // Rounds still to play: the table renders and nobody is crowned.
    page.render({
      event: buildSwissStandingsEvent({
        results: buildSwissStandingsResults({ complete: false, champion: null }),
      }),
    })

    expect(page.querySwissPanel('ev-swiss')).not.toBeNull()
    expect(page.querySwissChampion('ev-swiss')).toBeNull()
  })

  it('renders nothing for an event with no results', () => {
    page.render({ event: buildEvent() })

    expect(page.queryStandingsPanel('ev-open-singles')).toBeNull()
    expect(page.queryFinishesPanel('ev-open-singles')).toBeNull()
    expect(page.querySwissPanel('ev-open-singles')).toBeNull()
  })
})
