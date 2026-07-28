import { within } from '@/test/utilities'

import {
  buildFinishesEvent,
  buildFinishesResults,
  buildFinishRow,
} from '../../../../data/seed.factory'
import { finishesPanelPage as page } from './finishes-panel.page'

/** The player cell (2nd column) of a finish row — where the champion accent lives. */
const playerCellOf = (entryId: string) =>
  within(page.getRow(entryId)).getAllByRole('cell')[1]

describe('FinishesPanel', () => {
  // The equivalence guard for the props refactor (the panel is handed its finishes instead
  // of deriving them from the event). Pinned on the pre-refactor component, so it reds on
  // ANY rendered difference — a moved wrapper, a dropped class, a changed test id — not just
  // on the few strings the other tests happen to name.
  it('renders exactly this DOM for the default single-elimination event', () => {
    page.render()

    // The heading is wired to the section (`aria-labelledby`), which the snapshot cannot
    // assert: it normalizes React's generated ids away.
    expect(page.getRegion()).toBe(page.getPanel('ev-single-elim'))
    expect(page.getPanelHtml('ev-single-elim')).toMatchInlineSnapshot(`"<section data-testid="finishes-panel-ev-single-elim" aria-labelledby="ID" class="mt-2.5"><h3 id="ID" class="text-[11px] font-semibold tracking-[0.12em] text-[color:var(--fg-3)] uppercase">Finishes</h3><p data-testid="finishes-champion-ev-single-elim" class="mt-1.5 flex items-center gap-1.5 rounded-[10px] border border-[color:rgba(255,122,26,0.3)] bg-[color:var(--bg-accent-soft)] px-3 py-2 text-[13px] font-medium text-[color:var(--fg-1)] [box-shadow:var(--shadow-glow)]"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-trophy text-[color:var(--ball-500)]" aria-hidden="true"><path d="M10 14.66v1.626a2 2 0 0 1-.976 1.696A5 5 0 0 0 7 21.978"></path><path d="M14 14.66v1.626a2 2 0 0 0 .976 1.696A5 5 0 0 1 17 21.978"></path><path d="M18 9h1.5a1 1 0 0 0 0-5H18"></path><path d="M4 22h16"></path><path d="M6 9a6 6 0 0 0 12 0V3a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1z"></path><path d="M6 9H4.5a1 1 0 0 1 0-5H6"></path></svg><span class="text-[color:var(--fg-3)]">Champion</span><span class="text-[color:var(--ball-500)]">player.1</span></p><div data-slot="table-container" class="relative w-full overflow-x-auto"><table data-slot="table" class="w-full caption-bottom mt-2 text-[13px]" aria-label="Finishes for Championship Singles"><thead data-slot="table-header" class="[&amp;_tr]:border-b"><tr data-slot="table-row" class="border-b transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted"><th data-slot="table-head" class="h-10 px-2 align-middle font-medium whitespace-nowrap text-foreground [&amp;:has([role=checkbox])]:pr-0 w-12 text-right font-mono tabular-nums"><span aria-hidden="true">#</span><span class="sr-only">Finishing position</span></th><th data-slot="table-head" class="h-10 px-2 text-left align-middle font-medium whitespace-nowrap text-foreground [&amp;:has([role=checkbox])]:pr-0">Player</th></tr></thead><tbody data-slot="table-body" class="[&amp;_tr:last-child]:border-0"><tr data-slot="table-row" class="border-b transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted" data-testid="finish-row-entry-1"><td data-slot="table-cell" class="p-2 align-middle whitespace-nowrap [&amp;:has([role=checkbox])]:pr-0 text-right font-mono tabular-nums text-[color:var(--fg-3)]">1st</td><td data-slot="table-cell" class="p-2 align-middle whitespace-nowrap [&amp;:has([role=checkbox])]:pr-0 flex items-center gap-1.5 font-medium text-[color:var(--ball-500)]"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-trophy text-[color:var(--ball-500)]" aria-hidden="true"><path d="M10 14.66v1.626a2 2 0 0 1-.976 1.696A5 5 0 0 0 7 21.978"></path><path d="M14 14.66v1.626a2 2 0 0 0 .976 1.696A5 5 0 0 1 17 21.978"></path><path d="M18 9h1.5a1 1 0 0 0 0-5H18"></path><path d="M4 22h16"></path><path d="M6 9a6 6 0 0 0 12 0V3a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1z"></path><path d="M6 9H4.5a1 1 0 0 1 0-5H6"></path></svg>player.1</td></tr><tr data-slot="table-row" class="border-b transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted" data-testid="finish-row-entry-2"><td data-slot="table-cell" class="p-2 align-middle whitespace-nowrap [&amp;:has([role=checkbox])]:pr-0 text-right font-mono tabular-nums text-[color:var(--fg-3)]">2nd</td><td data-slot="table-cell" class="p-2 align-middle whitespace-nowrap [&amp;:has([role=checkbox])]:pr-0 text-[color:var(--fg-1)]">player.2</td></tr><tr data-slot="table-row" class="border-b transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted" data-testid="finish-row-entry-3"><td data-slot="table-cell" class="p-2 align-middle whitespace-nowrap [&amp;:has([role=checkbox])]:pr-0 text-right font-mono tabular-nums text-[color:var(--fg-3)]">T3</td><td data-slot="table-cell" class="p-2 align-middle whitespace-nowrap [&amp;:has([role=checkbox])]:pr-0 text-[color:var(--fg-1)]">player.3</td></tr><tr data-slot="table-row" class="border-b transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted" data-testid="finish-row-entry-4"><td data-slot="table-cell" class="p-2 align-middle whitespace-nowrap [&amp;:has([role=checkbox])]:pr-0 text-right font-mono tabular-nums text-[color:var(--fg-3)]">T3</td><td data-slot="table-cell" class="p-2 align-middle whitespace-nowrap [&amp;:has([role=checkbox])]:pr-0 text-[color:var(--fg-1)]">player.4</td></tr></tbody></table></div></section>"`)
  })

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

  // NOTE: "renders NOTHING for an event with no results" used to live here. The panel is now
  // handed a `FinishesView` and cannot be given "no results" at all — that state is a compile
  // error, and the decision belongs to `ResultsPanel`, whose own suite asserts it ("renders
  // nothing for an event with no results").
})
