import {
  buildEvent,
  buildEventResults,
  buildPool,
  buildPoolStandings,
  buildStandingRow,
  buildStandingsEvent,
} from '../../../../data/seed.factory'
import { standingsPanelPage as page } from './standings-panel.page'

describe('StandingsPanel', () => {
  it('shows a standings table per pool, entrants joined to their names', () => {
    // The default: a complete single-pool U1200 event (`ev-u1200`), Pool A of player.1 /
    // player.4 / player.5. The panel joins each row's entry id to a name off the event's
    // entrants — a table of raw uuids would pass a "renders standings" check and tell a
    // director nothing.
    page.render()

    expect(page.getPoolTableNames()).toEqual(['Standings for Pool A'])
    expect(page.getRowNames('Pool A')).toEqual(['player.1', 'player.4', 'player.5'])
  })

  it('names the champion once the event is complete', () => {
    page.render()

    const champion = page.queryChampion('ev-u1200')
    expect(champion).not.toBeNull()
    // The champion is `entry-1`, joined to a name — not the entry id.
    expect(champion).toHaveTextContent('player.1')
  })

  it('does NOT show a champion while the event is still being played', () => {
    // Live standings: the table fills in as matches complete, but there is no champion
    // until every fixture is decided. `champion` is `null` and `complete` is false, so the
    // callout is absent while the pool table is present.
    page.render({
      event: buildStandingsEvent({
        results: buildEventResults({
          complete: false,
          champion: null,
          pools: [buildPoolStandings({ complete: false })],
        }),
      }),
    })

    expect(page.queryChampion('ev-u1200')).toBeNull()
    expect(page.getPoolTableNames()).toEqual(['Standings for Pool A'])
  })

  it('shows every pool but NO champion for a complete multi-pool event', () => {
    // A multi-pool round-robin has no single champion without a knockout stage to join its
    // pool winners (a later slice), so `champion` is `null` even when complete — the pool
    // tables render, the callout does not.
    page.render({
      event: buildStandingsEvent({
        pools: [
          buildPool({ id: 'p-a', name: 'Pool A' }),
          buildPool({ id: 'p-b', name: 'Pool B' }),
        ],
        results: buildEventResults({
          complete: true,
          champion: null,
          pools: [
            buildPoolStandings({ poolId: 'p-a' }),
            buildPoolStandings({
              poolId: 'p-b',
              rows: [
                buildStandingRow({ entryId: 'entry-2', rank: 1 }),
                buildStandingRow({ entryId: 'entry-3', rank: 2 }),
              ],
            }),
          ],
        }),
      }),
    })

    expect(page.getPoolTableNames()).toEqual([
      'Standings for Pool A',
      'Standings for Pool B',
    ])
    expect(page.queryChampion('ev-u1200')).toBeNull()
  })

  it('renders NOTHING for an event with no results', () => {
    // An uncut event (and any non-round-robin one) has `results: null` — nothing to stand.
    // The panel is a designed empty state: it renders no section at all, rather than an
    // empty table that would read as a played event with nobody in it.
    page.render({ event: buildEvent() })

    expect(page.queryPanel('ev-open-singles')).toBeNull()
  })

  it('shows a withdrawn champion as “Withdrawn”, never a raw id', () => {
    // The champion could name an entry the event no longer lists — a winner who withdrew
    // afterward. The view-model joins that to `Withdrawn`; the callout shows the word, not
    // the uuid.
    page.render({
      event: buildStandingsEvent({
        results: buildEventResults({ complete: true, champion: 'entry-gone' }),
      }),
    })

    expect(page.queryChampion('ev-u1200')).toHaveTextContent('Withdrawn')
  })
})
