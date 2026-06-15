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
