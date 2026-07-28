import {
  buildEventResults,
  buildPool,
  buildPoolStandings,
  buildStandingRow,
  buildStandingsEvent,
} from '../../../../data/seed.factory'
import { standingsPanelPage as page } from './standings-panel.page'

describe('StandingsPanel', () => {
  // The equivalence guard for the props refactor (the panel is handed its standings instead
  // of deriving them from the event). Pinned on the pre-refactor component, so it reds on
  // ANY rendered difference — a moved wrapper, a dropped class, a changed test id — not just
  // on the few strings the other tests happen to name.
  it('renders exactly this DOM for the default round-robin event', () => {
    page.render()

    // The heading is wired to the section (`aria-labelledby`), which the snapshot cannot
    // assert: it normalizes React's generated ids away.
    expect(page.getRegion()).toBe(page.getPanel('ev-u1200'))
    expect(page.getPanelHtml('ev-u1200')).toMatchInlineSnapshot(`"<section data-testid="standings-panel-ev-u1200" aria-labelledby="ID" class="mt-2.5"><h3 id="ID" class="text-[11px] font-semibold tracking-[0.12em] text-[color:var(--fg-3)] uppercase">Standings</h3><p data-testid="standings-champion-ev-u1200" class="mt-1.5 flex items-center gap-1.5 rounded-[10px] border border-[color:rgba(255,122,26,0.3)] bg-[color:var(--bg-accent-soft)] px-3 py-2 text-[13px] font-medium text-[color:var(--fg-1)] [box-shadow:var(--shadow-glow)]"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-trophy text-[color:var(--ball-500)]" aria-hidden="true"><path d="M10 14.66v1.626a2 2 0 0 1-.976 1.696A5 5 0 0 0 7 21.978"></path><path d="M14 14.66v1.626a2 2 0 0 0 .976 1.696A5 5 0 0 1 17 21.978"></path><path d="M18 9h1.5a1 1 0 0 0 0-5H18"></path><path d="M4 22h16"></path><path d="M6 9a6 6 0 0 0 12 0V3a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1z"></path><path d="M6 9H4.5a1 1 0 0 1 0-5H6"></path></svg><span class="text-[color:var(--fg-3)]">Champion</span><span class="text-[color:var(--ball-500)]">player.1</span></p><div class="mt-2 flex flex-col gap-2.5"><section data-testid="pool-standings-p-a" aria-labelledby="ID" class="rounded-[10px] border border-[color:var(--border-subtle)] p-3"><h4 id="ID" class="text-[13px] font-semibold text-[color:var(--fg-1)]">Pool A</h4><div data-slot="table-container" class="relative w-full overflow-x-auto"><table data-slot="table" class="w-full caption-bottom mt-2 text-[13px]" aria-label="Standings for Pool A"><thead data-slot="table-header" class="[&amp;_tr]:border-b"><tr data-slot="table-row" class="border-b transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted"><th data-slot="table-head" class="h-10 px-2 align-middle font-medium whitespace-nowrap text-foreground [&amp;:has([role=checkbox])]:pr-0 w-8 text-right font-mono tabular-nums"><span aria-hidden="true">#</span><span class="sr-only">Rank</span></th><th data-slot="table-head" class="h-10 px-2 text-left align-middle font-medium whitespace-nowrap text-foreground [&amp;:has([role=checkbox])]:pr-0">Player</th><th data-slot="table-head" class="h-10 px-2 align-middle font-medium whitespace-nowrap text-foreground [&amp;:has([role=checkbox])]:pr-0 text-right font-mono tabular-nums"><span aria-hidden="true">W</span><span class="sr-only">Wins</span></th><th data-slot="table-head" class="h-10 px-2 align-middle font-medium whitespace-nowrap text-foreground [&amp;:has([role=checkbox])]:pr-0 text-right font-mono tabular-nums"><span aria-hidden="true">L</span><span class="sr-only">Losses</span></th><th data-slot="table-head" class="h-10 px-2 align-middle font-medium whitespace-nowrap text-foreground [&amp;:has([role=checkbox])]:pr-0 text-right font-mono tabular-nums"><span aria-hidden="true">Diff</span><span class="sr-only">Game difference</span></th><th data-slot="table-head" class="h-10 px-2 align-middle font-medium whitespace-nowrap text-foreground [&amp;:has([role=checkbox])]:pr-0 text-right font-mono tabular-nums"><span aria-hidden="true">GW</span><span class="sr-only">Games won</span></th></tr></thead><tbody data-slot="table-body" class="[&amp;_tr:last-child]:border-0"><tr data-slot="table-row" class="border-b transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted" data-testid="standing-row-entry-1"><td data-slot="table-cell" class="p-2 align-middle whitespace-nowrap [&amp;:has([role=checkbox])]:pr-0 text-right font-mono tabular-nums text-[color:var(--fg-3)]">1</td><td data-slot="table-cell" class="p-2 align-middle whitespace-nowrap [&amp;:has([role=checkbox])]:pr-0 text-[color:var(--fg-1)]">player.1</td><td data-slot="table-cell" class="p-2 align-middle whitespace-nowrap [&amp;:has([role=checkbox])]:pr-0 text-right font-mono tabular-nums">2</td><td data-slot="table-cell" class="p-2 align-middle whitespace-nowrap [&amp;:has([role=checkbox])]:pr-0 text-right font-mono tabular-nums">0</td><td data-slot="table-cell" class="p-2 align-middle whitespace-nowrap [&amp;:has([role=checkbox])]:pr-0 text-right font-mono tabular-nums text-[color:var(--fg-2)]">+3</td><td data-slot="table-cell" class="p-2 align-middle whitespace-nowrap [&amp;:has([role=checkbox])]:pr-0 text-right font-mono tabular-nums">4</td></tr><tr data-slot="table-row" class="border-b transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted" data-testid="standing-row-entry-4"><td data-slot="table-cell" class="p-2 align-middle whitespace-nowrap [&amp;:has([role=checkbox])]:pr-0 text-right font-mono tabular-nums text-[color:var(--fg-3)]">2</td><td data-slot="table-cell" class="p-2 align-middle whitespace-nowrap [&amp;:has([role=checkbox])]:pr-0 text-[color:var(--fg-1)]">player.4</td><td data-slot="table-cell" class="p-2 align-middle whitespace-nowrap [&amp;:has([role=checkbox])]:pr-0 text-right font-mono tabular-nums">1</td><td data-slot="table-cell" class="p-2 align-middle whitespace-nowrap [&amp;:has([role=checkbox])]:pr-0 text-right font-mono tabular-nums">1</td><td data-slot="table-cell" class="p-2 align-middle whitespace-nowrap [&amp;:has([role=checkbox])]:pr-0 text-right font-mono tabular-nums text-[color:var(--fg-2)]">0</td><td data-slot="table-cell" class="p-2 align-middle whitespace-nowrap [&amp;:has([role=checkbox])]:pr-0 text-right font-mono tabular-nums">3</td></tr><tr data-slot="table-row" class="border-b transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted" data-testid="standing-row-entry-5"><td data-slot="table-cell" class="p-2 align-middle whitespace-nowrap [&amp;:has([role=checkbox])]:pr-0 text-right font-mono tabular-nums text-[color:var(--fg-3)]">3</td><td data-slot="table-cell" class="p-2 align-middle whitespace-nowrap [&amp;:has([role=checkbox])]:pr-0 text-[color:var(--fg-1)]">player.5</td><td data-slot="table-cell" class="p-2 align-middle whitespace-nowrap [&amp;:has([role=checkbox])]:pr-0 text-right font-mono tabular-nums">0</td><td data-slot="table-cell" class="p-2 align-middle whitespace-nowrap [&amp;:has([role=checkbox])]:pr-0 text-right font-mono tabular-nums">2</td><td data-slot="table-cell" class="p-2 align-middle whitespace-nowrap [&amp;:has([role=checkbox])]:pr-0 text-right font-mono tabular-nums text-[color:var(--fg-2)]">-3</td><td data-slot="table-cell" class="p-2 align-middle whitespace-nowrap [&amp;:has([role=checkbox])]:pr-0 text-right font-mono tabular-nums">1</td></tr></tbody></table></div></section></div></section>"`)
  })

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

  // NOTE: "renders NOTHING for an event with no results" used to live here. The panel is now
  // handed a `StandingsView` and cannot be given "no results" at all — that state is a
  // compile error, and the decision belongs to `ResultsPanel`, whose own suite asserts it
  // ("renders nothing for an event with no results").

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
