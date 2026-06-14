import { matchListPage } from './match-list.page'
import { matchListResponse, matchListRow } from './match-list.factory'

// The heavy behavior coverage (skeleton→rows, session gate, debounce, URL
// hydration, page clamp, CSV filter) lives in src/routes/matches/index.test.tsx
// against the thin route and stays unchanged. These tests cover only that the
// orchestrator wires its four presentational children and feeds the table
// projected row view models.
describe('MatchList', () => {
  it('wires ActionBar, FilterRow, MatchListTable and PaginationFooter into the .match-list-page shell', async () => {
    // Wiring only — each child's internals are pinned by its own quartet's test.
    matchListPage.mockEndpoint(
      matchListResponse({
        items: [matchListRow({ opponent: 'nguyen.t' })],
        total: 1,
        status_counts: { in_progress: 1 },
      }),
    )
    matchListPage.render()

    // Await the first settled row (router + query resolved), then read the rest
    // synchronously.
    await matchListPage.findRow('Open match: rita.kovac vs nguyen.t')

    // ActionBar: the live pill reads the in_progress count, and the export +
    // new-match links are present.
    expect(matchListPage.actionBar.getNewMatchLink()).toBeInTheDocument()
    expect(matchListPage.actionBar.getLivePill(1)).toBeInTheDocument()
    expect(matchListPage.actionBar.getExportLink()).toHaveAttribute('download')

    // FilterRow: the status tabs are rendered (incl. the "Up next" tab).
    expect(matchListPage.filterRow.getTab(/up next/i)).toBeInTheDocument()
    expect(matchListPage.filterRow.getSearchInput()).toBeInTheDocument()

    // MatchListTable: the settled table renders (no aria-busy once loaded).
    expect(matchListPage.table.getTable()).not.toHaveAttribute('aria-busy')

    // PaginationFooter: the range readout reflects the single match.
    expect(matchListPage.footer.getInfo()).toHaveTextContent(
      'Showing 1–1 of 1 matches',
    )
  })

  it('projects raw rows into row view models before handing them to the table (a known opponent renders)', async () => {
    // Wiring only: the projection branches (perspective, score, tone, time) are
    // pinned by match-list-row-view.test.ts — here we only confirm the
    // orchestrator runs projectMatchListRow and the result reaches the table.
    matchListPage.mockEndpoint(
      matchListResponse({
        items: [matchListRow({ opponent: 'nguyen.t' })],
        total: 1,
        status_counts: { in_progress: 1 },
      }),
    )
    matchListPage.render()

    // The projection runs side labels through `projectMatchListRow`, so the
    // opponent surfaces in the row's composed aria-label — evidence the raw row
    // became a view model before reaching the table.
    const row = await matchListPage.findRow(
      'Open match: rita.kovac vs nguyen.t',
    )
    expect(row).toBeInTheDocument()
  })
})
