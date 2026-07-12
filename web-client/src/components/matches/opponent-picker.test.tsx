import { HttpResponse } from 'msw'
import userEvent from '@testing-library/user-event'

import { buildPlayer } from '@/mocks/factories/players/player.factory'

import { opponentPickerPage } from './opponent-picker.page'

function mockRecentOne() {
  opponentPickerPage.mockRecent(() =>
    HttpResponse.json([buildPlayer({ id: 'pl-1', username: 'ada.lovelace' })]),
  )
}

describe('OpponentPicker', () => {
  it('switches from the recent grid to the search typeahead', async () => {
    const user = userEvent.setup()
    mockRecentOne()
    opponentPickerPage.mockSearch(() => HttpResponse.json([]))
    opponentPickerPage.render()

    await opponentPickerPage.findChip(/ada\.lovelace/)
    expect(opponentPickerPage.queryCombobox()).not.toBeInTheDocument()

    await user.click(opponentPickerPage.querySearchAll()!)
    expect(opponentPickerPage.queryCombobox()).toBeInTheDocument()
  })

  it('focuses the search input the first time search is opened (#131)', async () => {
    const user = userEvent.setup()
    mockRecentOne()
    opponentPickerPage.mockSearch(() => HttpResponse.json([]))
    opponentPickerPage.render()

    await opponentPickerPage.findChip(/ada\.lovelace/)
    await user.click(opponentPickerPage.querySearchAll()!)

    expect(opponentPickerPage.getCombobox()).toHaveFocus()
  })

  it('preserves the typed query when retrying after a failed search, and re-runs it (#96)', async () => {
    const user = userEvent.setup()
    mockRecentOne()
    let searchCalls = 0
    opponentPickerPage.mockSearch(() => {
      searchCalls += 1
      if (searchCalls === 1) {
        return HttpResponse.json([], { status: 500 })
      }
      return HttpResponse.json([
        buildPlayer({ id: 'pl-9', username: 'barbara.liskov' }),
      ])
    })
    opponentPickerPage.render()

    await opponentPickerPage.findChip(/ada\.lovelace/)
    await user.click(opponentPickerPage.querySearchAll()!)
    await user.type(opponentPickerPage.getCombobox(), 'liskov')

    // The first search fails into the picker's error boundary.
    expect(await opponentPickerPage.findAlert()).toHaveTextContent(
      /couldn.t load players/i,
    )

    // "Try again" resets the boundary; the query and search view survive.
    await user.click(opponentPickerPage.getRetry())

    expect(
      await opponentPickerPage.findOption(/barbara\.liskov/),
    ).toBeInTheDocument()
    // The typed query was preserved and re-run — not dropped back to recents.
    expect(opponentPickerPage.getCombobox()).toHaveValue('liskov')
  })

  it('does not yank focus back to the input after error recovery (#131)', async () => {
    const user = userEvent.setup()
    mockRecentOne()
    let searchCalls = 0
    opponentPickerPage.mockSearch(() => {
      searchCalls += 1
      if (searchCalls === 1) {
        return HttpResponse.json([], { status: 500 })
      }
      return HttpResponse.json([
        buildPlayer({ id: 'pl-9', username: 'barbara.liskov' }),
      ])
    })
    opponentPickerPage.render()

    await opponentPickerPage.findChip(/ada\.lovelace/)
    await user.click(opponentPickerPage.querySearchAll()!)
    await user.type(opponentPickerPage.getCombobox(), 'liskov')
    await opponentPickerPage.findAlert()

    await user.click(opponentPickerPage.getRetry())
    await opponentPickerPage.findOption(/barbara\.liskov/)

    // The remount after recovery must not steal focus (the one-shot focus flag
    // was already consumed on first open).
    expect(opponentPickerPage.getCombobox()).not.toHaveFocus()
  })

  it('opens straight into search when defaultToSearch is set, focused', async () => {
    opponentPickerPage.mockSearch(() => HttpResponse.json([]))
    opponentPickerPage.render({ defaultToSearch: true })

    expect(opponentPickerPage.queryCombobox()).toBeInTheDocument()
    // The dashboard hero opens into search — the input should be focused on
    // mount so the user can type without a click.
    expect(opponentPickerPage.getCombobox()).toHaveFocus()
  })

  describe('back to recent opponents (#895)', () => {
    it('returns to the recent grid when the back control is activated', async () => {
      const user = userEvent.setup()
      mockRecentOne()
      opponentPickerPage.mockSearch(() => HttpResponse.json([]))
      opponentPickerPage.render()

      await opponentPickerPage.findChip(/ada\.lovelace/)
      await user.click(opponentPickerPage.querySearchAll()!)
      expect(opponentPickerPage.queryCombobox()).toBeInTheDocument()

      // The exit search mode never had: an explicit, visible way back.
      await user.click(await opponentPickerPage.findBackToRecent())

      expect(
        await opponentPickerPage.findChip(/ada\.lovelace/),
      ).toBeInTheDocument()
      expect(opponentPickerPage.queryCombobox()).not.toBeInTheDocument()
      expect(opponentPickerPage.querySearchAll()).toBeInTheDocument()
      expect(opponentPickerPage.queryBackToRecent()).not.toBeInTheDocument()
    })

    it('reports the abandoned query as empty so the card stops reading as "seeking"', async () => {
      const user = userEvent.setup()
      mockRecentOne()
      opponentPickerPage.mockSearch(() => HttpResponse.json([]))
      const queries: string[] = []
      opponentPickerPage.render({ onQueryChange: (q) => queries.push(q) })

      await opponentPickerPage.findChip(/ada\.lovelace/)
      await user.click(opponentPickerPage.querySearchAll()!)
      await user.type(opponentPickerPage.getCombobox(), 'liskov')
      expect(queries.at(-1)).toBe('liskov')

      await user.click(await opponentPickerPage.findBackToRecent())

      // Backing out of search is abandoning the hunt — the parent must hear the
      // query die, or its `seeking` state outlives the search box (#893/#895).
      expect(queries.at(-1)).toBe('')
    })

    it('does not keep the abandoned query when search is re-entered', async () => {
      const user = userEvent.setup()
      mockRecentOne()
      opponentPickerPage.mockSearch(() => HttpResponse.json([]))
      opponentPickerPage.render()

      await opponentPickerPage.findChip(/ada\.lovelace/)
      await user.click(opponentPickerPage.querySearchAll()!)
      await user.type(opponentPickerPage.getCombobox(), 'liskov')
      await user.click(await opponentPickerPage.findBackToRecent())
      await opponentPickerPage.findChip(/ada\.lovelace/)

      // Search still works on the way back in, from a clean box and focused.
      await user.click(opponentPickerPage.querySearchAll()!)
      expect(opponentPickerPage.getCombobox()).toHaveValue('')
      expect(opponentPickerPage.getCombobox()).toHaveFocus()
    })

    it('moves focus to "Search all players" so the keyboard user keeps their place', async () => {
      const user = userEvent.setup()
      mockRecentOne()
      opponentPickerPage.mockSearch(() => HttpResponse.json([]))
      opponentPickerPage.render()

      await opponentPickerPage.findChip(/ada\.lovelace/)
      await user.click(opponentPickerPage.querySearchAll()!)
      await user.click(await opponentPickerPage.findBackToRecent())

      // The back control unmounts itself — focus lands on the control that
      // opened search, not on the document body.
      await opponentPickerPage.findChip(/ada\.lovelace/)
      expect(opponentPickerPage.querySearchAll()).toHaveFocus()
    })

    it('escapes a failed search back to the recent grid', async () => {
      const user = userEvent.setup()
      mockRecentOne()
      opponentPickerPage.mockSearch(() => HttpResponse.json([], { status: 500 }))
      opponentPickerPage.render()

      await opponentPickerPage.findChip(/ada\.lovelace/)
      await user.click(opponentPickerPage.querySearchAll()!)
      await user.type(opponentPickerPage.getCombobox(), 'liskov')
      await opponentPickerPage.findAlert()

      // "Try again" is not the only way out of a broken search — the back
      // control sits outside the boundary and still works, and leaving search
      // clears the boundary's error rather than pinning the fallback in place.
      await user.click(await opponentPickerPage.findBackToRecent())

      expect(
        await opponentPickerPage.findChip(/ada\.lovelace/),
      ).toBeInTheDocument()
    })

    it('offers no way "back" to a caller that opened straight into search', async () => {
      const user = userEvent.setup()
      opponentPickerPage.mockSearch(() => HttpResponse.json([]))
      // The dashboard's first-match hero: it has no recent-opponents framing of
      // its own, so a "Back to recent opponents" control would strand the user.
      opponentPickerPage.render({ defaultToSearch: true })

      expect(opponentPickerPage.queryBackToRecent()).not.toBeInTheDocument()

      await user.type(opponentPickerPage.getCombobox(), 'liskov')
      expect(opponentPickerPage.queryBackToRecent()).not.toBeInTheDocument()
    })
  })

  it('surfaces a failed recent-opponents load in the error boundary (#96)', async () => {
    let calls = 0
    opponentPickerPage.mockRecent(() => {
      calls += 1
      if (calls === 1) {
        return HttpResponse.json([], { status: 500 })
      }
      return HttpResponse.json([
        buildPlayer({ id: 'pl-1', username: 'ada.lovelace' }),
      ])
    })
    const user = userEvent.setup()
    opponentPickerPage.render()

    expect(await opponentPickerPage.findAlert()).toHaveTextContent(
      /couldn.t load players/i,
    )
    await user.click(opponentPickerPage.getRetry())
    expect(await opponentPickerPage.findChip(/ada\.lovelace/)).toBeInTheDocument()
  })
})
