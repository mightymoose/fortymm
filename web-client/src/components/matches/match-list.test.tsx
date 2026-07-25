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

    // PaginationFooter: the range readout reflects the single match, inflected
    // to the singular. "of 1 match" is a substring of the ungrammatical "of 1
    // matches", so also assert the plural is absent — otherwise this stays
    // green against a regression back to a fixed plural.
    expect(matchListPage.footer.getInfo()).toHaveTextContent(
      'Showing 1–1 of 1 match',
    )
    expect(matchListPage.footer.getInfo()).not.toHaveTextContent(/of 1 matches/)
  })

  it('renders the Attention tab and the action CTA for an attention row when deep-linked', async () => {
    matchListPage.mockEndpoint(
      matchListResponse({
        items: [
          matchListRow({
            id: 'm-att',
            opponent: 'nguyen.t',
            status: 'in_progress',
            attention: 'score',
            current_game_number: 2,
          }),
        ],
        total: 1,
        status_counts: { in_progress: 1 },
        attention_count: 1,
      }),
    )
    matchListPage.render('/matches?status=attention')

    await matchListPage.findRow('Open match: rita.kovac vs nguyen.t')
    // The Attention tab exists in the filter row…
    expect(matchListPage.filterRow.getTab(/attention/i)).toBeInTheDocument()
    // …and the score row exposes an "Enter score" CTA into the scoring flow.
    expect(
      matchListPage.table.rows.getActionLink('Enter score'),
    ).toHaveAttribute('href', '/matches/m-att/games/2/scores/new')
  })

  // #1073: a tournament match is now born `pending` (scheduled) and only turns
  // `in_progress` (live) when it's called to a table. The status→tone/tab wiring
  // for `pending` already existed but was dead code (no row was ever pending).
  // This proves a real `pending` row files under "Up next" with the scheduled
  // tone — NOT Live, NOT Attention — now that one can actually arrive.
  it('files a pending match under "Up next" with the scheduled tone, never Live or Attention', async () => {
    matchListPage.mockEndpoint(
      matchListResponse({
        items: [
          matchListRow({
            id: 'm-pending',
            opponent: 'nguyen.t',
            status: 'pending',
            status_label: 'Scheduled',
            attention: null,
            current_game_number: null,
          }),
        ],
        total: 1,
        // status_counts / attention_count are computed by the factory from the
        // rows, mirroring the server: a pending row lands in `pending`, leaving
        // in_progress (Live) and attention at 0.
      }),
    )
    matchListPage.render('/matches?status=scheduled')

    await matchListPage.findRow('Open match: rita.kovac vs nguyen.t')

    // Projection: the row's status chip takes the *scheduled* tone, not live —
    // and carries no pulsing live-dot. (Would FAIL if `pending` toned `live`.)
    const badge = matchListPage.table.rows.getBadge('Scheduled')
    expect(badge).toHaveClass('status-tone-scheduled')
    expect(badge).not.toHaveClass('status-tone-live')
    expect(matchListPage.table.rows.queryLiveDot('Scheduled')).toBeNull()

    // A scheduled (not-yet-called) match has no move to make — no row CTA.
    expect(
      matchListPage.table.rows.queryActionLink('Enter score'),
    ).toBeNull()
    expect(
      matchListPage.table.rows.queryActionLink('Review result'),
    ).toBeNull()

    // Filed under "Up next" (count 1)…
    expect(matchListPage.filterRow.getTab(/up next/i)).toHaveTextContent('1')
    // …and NOT under Live: the Live tab and the header LIVE pill both read 0.
    // (Would FAIL if the pending row were bucketed as in_progress/live.)
    expect(matchListPage.filterRow.getTab(/live/i)).toHaveTextContent('0')
    expect(matchListPage.actionBar.getLivePill(0)).toBeInTheDocument()
    // …and NOT under Attention: attention is its own server dimension and a
    // born-pending row carries none, so the Attention tab reads 0.
    expect(matchListPage.filterRow.getTab(/attention/i)).toHaveTextContent('0')
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
