import userEvent from '@testing-library/user-event'
import { act, waitFor } from '@testing-library/react'

import { buildTournament } from './data/seed.factory'
import { tournamentsListPagePage } from './tournaments-list-page.page'

/** The page reads and writes URL state, so it mounts under a memory router that
 * resolves asynchronously — every test starts by awaiting the first paint. */
const renderList = async (
  ...args: Parameters<typeof tournamentsListPagePage.render>
) => {
  tournamentsListPagePage.render(...args)
  await tournamentsListPagePage.findSearch()
}

describe('TournamentsListPage', () => {
  it('filters the grid by search query', async () => {
    await renderList()
    expect(tournamentsListPagePage.getCard('Bay Area Open 2026')).toBeInTheDocument()

    await userEvent.type(tournamentsListPagePage.getSearch(), 'Winter')

    expect(tournamentsListPagePage.queryCard('Bay Area Open 2026')).toBeNull()
    expect(tournamentsListPagePage.getCard('Winter Classic 2025')).toBeInTheDocument()
  })

  // Diacritics: `toLowerCase()` folds case and never folds accents, so a user on
  // an ASCII keyboard could not reach an accented name at all. The fold is
  // symmetric, so it widens in both directions and never narrows.
  describe('searching a name that carries accents', () => {
    const ACCENTED = '\u00c1rea da Ba\u00eda Aberto'

    const renderWithAccented = () =>
      renderList({
        tournaments: [
          buildTournament({ id: 'bay', name: 'Bay Area Open 2026', status: 'published' }),
          buildTournament({ id: 'aberto', name: ACCENTED, status: 'published' }),
          buildTournament({ id: 'winter', name: 'Winter Classic 2025', status: 'archived' }),
        ],
      })

    it('finds it from unaccented text typed at the start of the name', async () => {
      await renderWithAccented()

      await userEvent.type(tournamentsListPagePage.getSearch(), 'area')

      expect(tournamentsListPagePage.getCard(ACCENTED)).toBeInTheDocument()
    })

    it('finds it from unaccented text in the middle of the name', async () => {
      await renderWithAccented()

      await userEvent.type(tournamentsListPagePage.getSearch(), 'baia')

      expect(tournamentsListPagePage.getCard(ACCENTED)).toBeInTheDocument()
      expect(tournamentsListPagePage.queryCard('Bay Area Open 2026')).toBeNull()
    })

    it('finds an unaccented name from accented text, because the fold is symmetric', async () => {
      await renderWithAccented()

      await userEvent.type(tournamentsListPagePage.getSearch(), '\u00c1rea')

      expect(tournamentsListPagePage.getCard('Bay Area Open 2026')).toBeInTheDocument()
    })

    it('still narrows on plain text — folding widens, it does not stop filtering', async () => {
      await renderWithAccented()

      await userEvent.type(tournamentsListPagePage.getSearch(), 'Winter')

      expect(tournamentsListPagePage.getCard('Winter Classic 2025')).toBeInTheDocument()
      expect(tournamentsListPagePage.queryCard('Bay Area Open 2026')).toBeNull()
      expect(tournamentsListPagePage.queryCard(ACCENTED)).toBeNull()
    })
  })

  it('filters the grid by status tab', async () => {
    await renderList()
    await userEvent.click(tournamentsListPagePage.getStatusTab('Drafts'))

    expect(tournamentsListPagePage.queryCard('Bay Area Open 2026')).toBeNull()
    expect(tournamentsListPagePage.getCard('Summer Slam 2026')).toBeInTheDocument()
  })

  it('opens a tournament when its card is clicked', async () => {
    const onOpen = vi.fn()
    await renderList({
      tournaments: [buildTournament({ id: 'bay', name: 'Bay Area Open 2026' })],
      onOpen,
    })

    await userEvent.click(tournamentsListPagePage.getCard('Bay Area Open 2026'))
    expect(onOpen).toHaveBeenCalledWith('bay')
  })

  it('confirms then deletes from the card delete control', async () => {
    const onDelete = vi.fn()
    await renderList({
      tournaments: [buildTournament({ id: 'bay', name: 'Bay Area Open 2026' })],
      onDelete,
    })

    await userEvent.click(tournamentsListPagePage.getDeleteButton('Bay Area Open 2026'))
    await userEvent.click(tournamentsListPagePage.getConfirmDeleteButton())
    expect(onDelete).toHaveBeenCalledWith('bay')
  })

  it('shows the New tournament action when the caller can create', async () => {
    await renderList({ canCreate: true })
    expect(tournamentsListPagePage.queryNewButtons().length).toBeGreaterThan(0)
  })

  it('hides every New tournament action when the caller cannot create', async () => {
    await renderList({ canCreate: false })
    expect(tournamentsListPagePage.queryNewButtons()).toHaveLength(0)
  })

  describe('the status tabs', () => {
    // The tab strip is derived from `TournamentStatus` via a `Record`, so this
    // asserts the whole strip rather than one tab: a status that loses its tab (the
    // #970 defect, where `live` had none) shows up here as a missing entry.
    it('renders one tab per status, plus All, in order', async () => {
      await renderList()

      expect(
        tournamentsListPagePage.getStatusTabs().map((t) => t.textContent),
      ).toEqual(['All', 'Drafts', 'Published', 'Live', 'Archived'])
    })

    it('the Live tab shows every live tournament and nothing else', async () => {
      await renderList()

      await userEvent.click(tournamentsListPagePage.getStatusTab('Live'))

      expect(tournamentsListPagePage.getCard('Autumn Cup 2026')).toBeInTheDocument()
      expect(tournamentsListPagePage.queryCard('Bay Area Open 2026')).toBeNull()
      expect(tournamentsListPagePage.queryCard('Summer Slam 2026')).toBeNull()
      expect(tournamentsListPagePage.queryCard('Winter Classic 2025')).toBeNull()
    })

    // The bug as Quinn found it: one live tournament, and Published reported
    // "0 results — No tournaments match" while the subtitle counted it as active.
    it('the Published tab excludes live tournaments', async () => {
      await renderList()

      await userEvent.click(tournamentsListPagePage.getStatusTab('Published'))

      expect(tournamentsListPagePage.getCard('Bay Area Open 2026')).toBeInTheDocument()
      expect(tournamentsListPagePage.queryCard('Autumn Cup 2026')).toBeNull()
    })
  })

  describe('the subtitle', () => {
    it('counts only live tournaments, and says so', async () => {
      await renderList()

      // Four rows, exactly one of them live.
      expect(tournamentsListPagePage.getSubtitle()).toHaveTextContent('4 total · 1 live')
    })

    it('reads 0 live when nothing has started', async () => {
      await renderList({
        tournaments: [
          buildTournament({ id: 'a', name: 'A Open', status: 'published' }),
          buildTournament({ id: 'b', name: 'B Open', status: 'published' }),
        ],
      })

      expect(tournamentsListPagePage.getSubtitle()).toHaveTextContent('2 total · 0 live')
    })
  })

  describe('the URL', () => {
    it('writes the selected status and drops it again on All', async () => {
      await renderList()

      await userEvent.click(tournamentsListPagePage.getStatusTab('Live'))
      await waitFor(() =>
        expect(tournamentsListPagePage.currentUrl()).toContain('status=live'),
      )

      await userEvent.click(tournamentsListPagePage.getStatusTab('All'))
      await waitFor(() =>
        expect(tournamentsListPagePage.currentUrl()).not.toContain('status'),
      )
    })

    it('writes the search text and drops it again when cleared', async () => {
      await renderList()

      await userEvent.type(tournamentsListPagePage.getSearch(), 'Winter')
      await waitFor(() =>
        expect(tournamentsListPagePage.currentUrl()).toContain('q=Winter'),
      )

      await userEvent.clear(tournamentsListPagePage.getSearch())
      await waitFor(() =>
        expect(tournamentsListPagePage.currentUrl()).not.toContain('q='),
      )
    })

    it('keeps whitespace-only search out of the URL', async () => {
      await renderList()

      await userEvent.type(tournamentsListPagePage.getSearch(), '   ')

      // It filters nothing, and it never becomes a `?q=%20%20%20` the user cannot see
      // or clear.
      await waitFor(() =>
        expect(tournamentsListPagePage.currentUrl()).not.toContain('q='),
      )
      expect(tournamentsListPagePage.getCard('Bay Area Open 2026')).toBeInTheDocument()
    })

    // One search is one intent. Without `replace: true` a six-letter query buries the
    // page the user arrived from under six history entries.
    it('replaces the history entry rather than stacking one per keystroke', async () => {
      await renderList()
      const before = tournamentsListPagePage.historyLength()

      await userEvent.type(tournamentsListPagePage.getSearch(), 'Winter')
      await waitFor(() =>
        expect(tournamentsListPagePage.currentUrl()).toContain('q=Winter'),
      )

      expect(tournamentsListPagePage.historyLength()).toBe(before)
    })

    it('restores both controls from a URL carrying status and q', async () => {
      await renderList({}, '/tournaments?status=published&q=Bay')

      expect(tournamentsListPagePage.getSearch()).toHaveValue('Bay')
      expect(tournamentsListPagePage.getStatusTab('Published')).toHaveAttribute(
        'aria-selected',
        'true',
      )
      expect(tournamentsListPagePage.getCard('Bay Area Open 2026')).toBeInTheDocument()
    })

    // A bookmark that predates a status rename must not 500 the page.
    it('falls back to All on an unrecognized status, without throwing', async () => {
      await renderList({}, '/tournaments?status=someoldvalue')

      expect(tournamentsListPagePage.getStatusTab('All')).toHaveAttribute(
        'aria-selected',
        'true',
      )
      // Nothing is filtered out — the whole list renders.
      expect(tournamentsListPagePage.getCard('Bay Area Open 2026')).toBeInTheDocument()
      expect(tournamentsListPagePage.getCard('Autumn Cup 2026')).toBeInTheDocument()
    })

    // The app shell's sidebar entry is `to: '/tournaments'` with no search, so clicking
    // it while a search is active is a SAME-ROUTE navigation — the URL drops `q` and
    // this component never unmounts. A search box that only seeds from the URL kept its
    // text and left the grid filtered while the URL said unfiltered.
    it('clears the box and the grid when a same-route navigation drops q', async () => {
      await renderList()

      await userEvent.type(tournamentsListPagePage.getSearch(), 'Winter')
      await waitFor(() =>
        expect(tournamentsListPagePage.queryCard('Bay Area Open 2026')).toBeNull(),
      )

      await act(async () => {
        await tournamentsListPagePage.navigateTo('/tournaments')
      })

      expect(tournamentsListPagePage.getSearch()).toHaveValue('')
      expect(tournamentsListPagePage.getCard('Bay Area Open 2026')).toBeInTheDocument()
    })

    // The other half of the same rule: a same-route navigation that CARRIES a q adopts
    // it, rather than leaving the box showing the previous search.
    it('adopts a q that a same-route navigation brings in', async () => {
      await renderList()

      await act(async () => {
        await tournamentsListPagePage.navigateTo('/tournaments', { q: 'Winter' })
      })

      expect(tournamentsListPagePage.getSearch()).toHaveValue('Winter')
      expect(tournamentsListPagePage.queryCard('Bay Area Open 2026')).toBeNull()
      expect(tournamentsListPagePage.getCard('Winter Classic 2025')).toBeInTheDocument()
    })

    // The schema's `.trim()` is a transform, so binding the input to the parsed value
    // would eat the trailing space and make a two-word search untypeable.
    it('lets a two-word search be typed', async () => {
      await renderList()

      await userEvent.type(tournamentsListPagePage.getSearch(), 'Bay Area')

      expect(tournamentsListPagePage.getSearch()).toHaveValue('Bay Area')
      expect(tournamentsListPagePage.getCard('Bay Area Open 2026')).toBeInTheDocument()
    })
  })

  describe('the empty states', () => {
    it('tells a user with nothing that there is nothing yet, without mentioning filters', async () => {
      await renderList({ tournaments: [] })

      expect(
        tournamentsListPagePage.queryEmptyTitle('No tournaments yet'),
      ).toBeInTheDocument()
      expect(tournamentsListPagePage.queryEmptyTitle(/Adjust the filters/)).toBeNull()
    })

    it('still offers the create action in the true-empty state', async () => {
      await renderList({ tournaments: [], canCreate: true })

      expect(tournamentsListPagePage.queryNewButtons().length).toBeGreaterThan(0)
    })

    it('offers no create action in the true-empty state without the permission', async () => {
      await renderList({ tournaments: [], canCreate: false })

      expect(
        tournamentsListPagePage.queryEmptyTitle('No tournaments yet'),
      ).toBeInTheDocument()
      expect(tournamentsListPagePage.queryNewButtons()).toHaveLength(0)
    })

    it('tells a user whose search matched nothing to adjust the filters', async () => {
      await renderList()

      await userEvent.type(tournamentsListPagePage.getSearch(), 'Nothing matches this')

      expect(
        tournamentsListPagePage.queryEmptyTitle('No tournaments match'),
      ).toBeInTheDocument()
      expect(tournamentsListPagePage.queryEmptyTitle('No tournaments yet')).toBeNull()
    })

    it('tells a user whose status tab matched nothing to adjust the filters', async () => {
      await renderList({
        tournaments: [
          buildTournament({ id: 'bay', name: 'Bay Area Open 2026', status: 'published' }),
        ],
      })

      await userEvent.click(tournamentsListPagePage.getStatusTab('Live'))

      expect(
        tournamentsListPagePage.queryEmptyTitle('No tournaments match'),
      ).toBeInTheDocument()
      expect(tournamentsListPagePage.queryEmptyTitle('No tournaments yet')).toBeNull()
    })

    // Near me filters SERVER-side, so it empties `tournaments` itself. Without the
    // flag this case is indistinguishable from owning nothing, and a user with six
    // tournaments fifty miles away is told to create their first.
    it('shows the adjust-the-filters state when Near me is on and matched nothing', async () => {
      await renderList({ tournaments: [], nearMeActive: true })

      expect(
        tournamentsListPagePage.queryEmptyTitle('No tournaments match'),
      ).toBeInTheDocument()
      expect(tournamentsListPagePage.queryEmptyTitle('No tournaments yet')).toBeNull()
    })
  })
})
