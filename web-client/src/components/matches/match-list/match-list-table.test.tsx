import userEvent from '@testing-library/user-event'

import { buildMatchListTableProps } from './match-list-table.factory'
import { buildMatchListRowView } from './match-list-table/match-list-row.factory'
import { matchListTablePage } from './match-list-table.page'

describe('MatchListTable', () => {
  it('renders the skeleton rows when isLoading and rows is empty', async () => {
    // Wiring only: skeleton internals are pinned by match-list-skeleton-rows.
    matchListTablePage.render({ isLoading: true, rows: [] })

    const table = await matchListTablePage.findTable()
    expect(table).toHaveAttribute('aria-busy', 'true')
    expect(matchListTablePage.queryEmptyState()).toBeNull()
  })

  it('renders the cold-start empty ("No matches yet", no Clear filters) when not loading, rows empty, and unfiltered', async () => {
    matchListTablePage.render({ isLoading: false, rows: [], isFiltered: false })

    const heading = await matchListTablePage.findEmptyState()
    expect(heading).toHaveTextContent('No matches yet')
    expect(heading.closest('.empty')).toHaveTextContent(
      'Start a new match to see what’s being played.',
    )
    // A first-run user has nothing to clear — the button would be a no-op, so
    // it's omitted (#373).
    expect(matchListTablePage.queryClearFiltersButton()).toBeNull()
  })

  it('renders the filtered no-result empty ("No matches match your filters" + Clear filters) when a filter is active and rows empty', async () => {
    // Regression for #373: a filtered/out-of-range no-result view must not
    // imply the user has never played.
    matchListTablePage.render({ isLoading: false, rows: [], isFiltered: true })

    const heading = await matchListTablePage.findEmptyState()
    expect(heading).toHaveTextContent('No matches match your filters')
    expect(matchListTablePage.queryColdStartHeading()).toBeNull()
    expect(heading.closest('.empty')).toHaveTextContent(
      'Try a different search or clear the filters to see what’s being played.',
    )
    expect(matchListTablePage.getClearFiltersButton()).toBeInTheDocument()
  })

  it('calls onClear when Clear filters is clicked (filtered empty)', async () => {
    const user = userEvent.setup()
    const onClear = buildMatchListTableProps().onClear
    matchListTablePage.render({
      isLoading: false,
      rows: [],
      isFiltered: true,
      onClear,
    })

    await matchListTablePage.findEmptyState()
    await user.click(matchListTablePage.getClearFiltersButton())
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it('renders a table with one MatchListRow per row when rows are present', async () => {
    // Wiring only: row internals are pinned by match-list-row tests.
    const rows = [
      buildMatchListRowView({
        id: 'm-1',
        ariaLabel: 'Open match: nguyen.t vs silva.r',
      }),
      buildMatchListRowView({
        id: 'm-2',
        ariaLabel: 'Open match: patel.m vs rita.kovac',
      }),
    ]
    matchListTablePage.render({ rows })

    await matchListTablePage.findTable()
    expect(
      matchListTablePage.rows.getRow('Open match: nguyen.t vs silva.r'),
    ).toBeInTheDocument()
    expect(
      matchListTablePage.rows.getRow('Open match: patel.m vs rita.kovac'),
    ).toBeInTheDocument()
  })

  it('does not show aria-busy on the settled table', async () => {
    matchListTablePage.render({ rows: [buildMatchListRowView()] })

    const table = await matchListTablePage.findTable()
    expect(table).not.toHaveAttribute('aria-busy')
  })
})
