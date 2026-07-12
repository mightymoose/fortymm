import userEvent from '@testing-library/user-event'
import { HttpResponse } from 'msw'

import { buildPlayerDetail } from '@/mocks/factories/players/player-detail.factory'
import { waitFor } from '@/test/utilities'

import {
  HISTORY_PAGE_SIZE,
  buildMixedStatusMatchRows,
  buildPlayerMatchPage,
  buildPlayerMatchRows,
} from './player-match-history.factory'
import { playerMatchHistoryPage as page } from './player-match-history.page'

/** One row past the page boundary — the size the whole file is built around.
 * 25 rows fit on page 1; the 26th is the only row on page 2. */
const ONE_PAST_A_PAGE = HISTORY_PAGE_SIZE + 1

describe('PlayerMatchHistory', () => {
  it('titles the page with the player’s name and offers a way back to their profile', async () => {
    page.mockMatches(buildPlayerMatchRows(3))
    page.render({
      playerId: 'p-1',
      player: buildPlayerDetail({ id: 'p-1', username: 'rita.kovac' }),
    })

    const title = await page.findTitle()
    expect(title).toHaveTextContent('rita.kovac')
    expect(title).toHaveTextContent('Match history')
    expect(page.getBackLink()).toHaveAttribute('href', '/players/p-1')
  })

  it('holds a skeleton — not an empty table — while the player is still resolving', async () => {
    // The matches query is gated behind the profile bundle, so there is nothing
    // to fetch yet: no endpoint stub, and MSW's `onUnhandledRequest: 'error'`
    // would fail this test if the table jumped the gun and fetched anyway.
    page.render({ playerId: 'p-1', player: null, isPending: true })

    await waitFor(() => expect(page.queryLoadingTable()).toBeInTheDocument())
    expect(page.queryTitle()).not.toBeInTheDocument()
    expect(page.queryTitleSkeleton()).toBeInTheDocument()
    expect(page.getRows()).toHaveLength(0)
    expect(page.queryEmptyState()).not.toBeInTheDocument()
  })

  it('fills page 1 with a whole page of rows and counts the whole history', async () => {
    const log = page.mockMatches(buildPlayerMatchRows(ONE_PAST_A_PAGE))
    page.render()

    await waitFor(() =>
      expect(page.getRows()).toHaveLength(HISTORY_PAGE_SIZE),
    )
    // The first and last row of page 1 — `opp.26` is over the boundary and must
    // NOT be here.
    expect(page.getOpponentNames()[0]).toBe('opp.01')
    expect(page.getOpponentNames().at(-1)).toBe('opp.25')
    expect(page.getOpponentNames()).not.toContain('opp.26')

    // The footer counts the whole history, not the page.
    expect(page.queryFooterSummary()).toBe('Showing 1–25 of 26 matches')
    expect(log.pages).toEqual([1])
    expect(log.pageSizes).toEqual([HISTORY_PAGE_SIZE])
  })

  it('pages past the page-size boundary: page 2 of a 26-match history shows the 26th match', async () => {
    // THE boundary case. Every fixture in the repo before this one was shorter
    // than a single page, so nothing has ever asserted that the second page of
    // a match history is fetched, rendered, and counted correctly.
    const user = userEvent.setup()
    const log = page.mockMatches(buildPlayerMatchRows(ONE_PAST_A_PAGE))
    page.render()

    await waitFor(() =>
      expect(page.getRows()).toHaveLength(HISTORY_PAGE_SIZE),
    )
    await user.click(page.getNextPageButton())

    // Page 2 holds exactly the one row that didn't fit on page 1.
    await waitFor(() => expect(page.getRows()).toHaveLength(1))
    expect(page.getOpponentNames()).toEqual(['opp.26'])
    // …and page 1's rows are gone, rather than being kept alongside it.
    expect(page.getOpponentNames()).not.toContain('opp.25')

    // The footer's counts read correctly *across* the boundary: the range is the
    // 26th of 26, not "26–50" and not a second "1–25".
    expect(page.queryFooterSummary()).toBe('Showing 26–26 of 26 matches')

    // The rows came from the server's page 2 — the client did not re-slice the
    // page it already had.
    expect(log.pages).toEqual([1, 2])

    // There is nowhere further to go, and page 1 is still reachable.
    expect(page.getNextPageButton()).toBeDisabled()
    expect(page.getPrevPageButton()).toBeEnabled()
    await user.click(page.getPageLink(1))
    await waitFor(() =>
      expect(page.getOpponentNames()[0]).toBe('opp.01'),
    )
    expect(page.queryFooterSummary()).toBe('Showing 1–25 of 26 matches')
  })

  it('renders every status the all-inclusive history carries, solo sentinel included', async () => {
    // ADR-0008: nothing is filtered out of this list — live, awaiting, up-next,
    // voided and the player-less solo row all belong in it.
    page.mockMatches(buildMixedStatusMatchRows())
    page.render()

    await waitFor(() => expect(page.getRows()).toHaveLength(6))
    expect(page.getResultChips()).toEqual([
      'LIVE',
      'AWAITING',
      'UP NEXT',
      'VOIDED',
      'LOSS',
      'WIN',
    ])
    expect(page.getOpponentNames()).toContain('No opponent')
  })

  it('shows the designed empty state for a player with no matches', async () => {
    page.mockMatches([])
    page.render()

    await waitFor(() => expect(page.queryEmptyState()).toBeInTheDocument())
    expect(page.getRows()).toHaveLength(0)
    expect(page.queryError()).not.toBeInTheDocument()
  })

  it('offers a retry when the matches fetch fails, and recovers on it', async () => {
    const user = userEvent.setup()
    let attempts = 0
    page.mockMatchesEndpoint(() => {
      attempts += 1
      return attempts === 1
        ? new HttpResponse(null, { status: 500 })
        : HttpResponse.json(buildPlayerMatchPage(buildPlayerMatchRows(2)))
    })
    page.render()

    const alert = await page.findError()
    expect(alert).toHaveTextContent('Couldn’t load matches')

    await user.click(page.getRetryButton())

    await waitFor(() => expect(page.getRows()).toHaveLength(2))
    expect(page.queryError()).not.toBeInTheDocument()
    expect(page.getOpponentNames()).toEqual(['opp.01', 'opp.02'])
  })

  it('snaps an out-of-range ?page= back to the last valid page (#637)', async () => {
    const onPageChange = vi.fn()
    page.mockMatches(buildPlayerMatchRows(ONE_PAST_A_PAGE))
    page.render({ page: 999, onPageChange })

    // The last valid page of a 26-match history is 2 — and it holds the 26th.
    await waitFor(() => expect(onPageChange).toHaveBeenCalledWith(2))
    await waitFor(() => expect(page.getOpponentNames()).toEqual(['opp.26']))
    expect(page.queryEmptyState()).not.toBeInTheDocument()
    expect(page.queryFooterSummary()).toBe('Showing 26–26 of 26 matches')
  })

  // These two were pinned against the *old* behaviour by the prefactor (3a), so
  // that #1006 lands as a visible flip rather than disappearing into a rewrite.
  // Before: a 2-match history rendered NO footer (the component gated it on
  // `total > PAGE_SIZE`) and carried its only count in a header chip. After: the
  // footer always renders, and the chip is gone.
  describe('a history of a page or less (#1006)', () => {
    it('still shows the count and the pager — the footer is not gated on the row count', async () => {
      page.mockMatches(buildPlayerMatchRows(2))
      page.render()

      await waitFor(() => expect(page.getRows()).toHaveLength(2))

      // Was `toBeNull()`: two matches used to render no footer at all, leaving
      // the page with a table and nothing under it.
      expect(page.queryFooterSummary()).toBe('Showing 1–2 of 2 matches')

      // The pager is present but goes nowhere: one page, so every control is
      // dead in both directions. *Present* and dead — not absent, which is what
      // a genuinely empty history gets instead (see the empty-state test below).
      expect(page.queryPagerButtons()).toHaveLength(4)
      expect(page.getFirstPageButton()).toBeDisabled()
      expect(page.getPrevPageButton()).toBeDisabled()
      expect(page.getNextPageButton()).toBeDisabled()
      expect(page.getLastPageButton()).toBeDisabled()
    })

    it('prints the count exactly once, in the footer — the header chip is gone', async () => {
      page.mockMatches(buildPlayerMatchRows(2))
      page.render()

      await waitFor(() => expect(page.getRows()).toHaveLength(2))

      // Was `expect(page.queryHeaderCount()).toHaveTextContent('2')`: the header
      // is now just its title.
      expect(page.getSectionHeaderText()).toBe('Matches')

      // …and "2" is printed in exactly one place on the page — the footer's
      // readout. This is the whole reason the chip went with the guard: showing
      // the footer *and* keeping the chip would have said the number twice.
      expect(page.getCountReadouts(2)).toHaveLength(1)
    })
  })

  it('shows the count once even for a history that spans pages', async () => {
    // The other side of "exactly once": with 26 matches, the header used to
    // print 26 and the footer printed it again. Now only the footer does.
    page.mockMatches(buildPlayerMatchRows(ONE_PAST_A_PAGE))
    page.render()

    await waitFor(() => expect(page.getRows()).toHaveLength(HISTORY_PAGE_SIZE))
    expect(page.getSectionHeaderText()).toBe('Matches')
    expect(page.getCountReadouts(ONE_PAST_A_PAGE)).toHaveLength(1)
    expect(page.queryFooterSummary()).toBe('Showing 1–25 of 26 matches')
  })

  it('shows the empty state and nothing else — no footer, no pager — for a player with no matches', async () => {
    // Inverted in place from 3b's pin (which asserted
    // `expect(page.queryFooterSummary()).toBe('Showing 0–0 of 0 matches')` and
    // `expect(page.getNextPageButton()).toBeDisabled()`): dropping the
    // `total > PAGE_SIZE` guard made the footer *fully* unconditional, so an
    // empty history said "No matches yet" and then restated it as
    // "Showing 0–0 of 0 matches" over four dead buttons — a pager with nothing
    // to page. The footer is now gated on `total > 0`, which is NOT the old
    // guard returning: a short-but-non-empty history still gets its footer — the
    // "a history of a page or less (#1006)" block above pins that, and the two
    // claims must hold together in this one file so neither can be traded for
    // the other.
    page.mockMatches([])
    page.render()

    await waitFor(() => expect(page.queryEmptyState()).toBeInTheDocument())
    expect(page.queryFooterSummary()).toBeNull()
    expect(page.queryPagerButtons()).toHaveLength(0)
    // The zero itself is nowhere on the page either — the empty state speaks for
    // it, rather than a "0" readout saying the same thing in numerals.
    expect(page.getCountReadouts(0)).toHaveLength(0)
  })
})
