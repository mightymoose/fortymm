import { HttpResponse } from 'msw'
import userEvent from '@testing-library/user-event'

import { buildPlayer } from '@/mocks/factories/players/player.factory'

import { opponentTypeaheadPage } from './opponent-typeahead.page'

const THREE_PLAYERS = [
  buildPlayer({ id: 'pl-1', username: 'ada.lovelace' }),
  buildPlayer({ id: 'pl-2', username: 'grace.hopper' }),
  buildPlayer({ id: 'pl-3', username: 'barbara.liskov' }),
]

/** Stub search to always return the same three players, then type to open the
 *  listbox and wait for the rows. Returns the rendered option elements. */
async function openWithResults() {
  const user = userEvent.setup()
  opponentTypeaheadPage.mockSearch(() => HttpResponse.json(THREE_PLAYERS))
  opponentTypeaheadPage.render()
  await user.type(opponentTypeaheadPage.getCombobox(), 'a')
  await opponentTypeaheadPage.findOption(/ada\.lovelace/)
  return { user, options: opponentTypeaheadPage.getOptions() }
}

describe('OpponentTypeahead', () => {
  it('marks the input as an ARIA combobox with an accessible label (#94)', () => {
    opponentTypeaheadPage.render()
    const combobox = opponentTypeaheadPage.getCombobox()

    expect(combobox).toHaveAttribute('aria-autocomplete', 'list')
    expect(combobox).toHaveAttribute('aria-expanded', 'true')
    expect(combobox).toHaveAccessibleName('Search players by username')
  })

  it('shows the pre-typing hint, then a no-match message that echoes the query (#94)', async () => {
    const user = userEvent.setup()
    opponentTypeaheadPage.mockSearch(() => HttpResponse.json([]))
    opponentTypeaheadPage.render()

    expect(
      opponentTypeaheadPage.queryByText(/start typing to search/i),
    ).toBeInTheDocument()

    await user.type(opponentTypeaheadPage.getCombobox(), 'zzz')
    expect(await opponentTypeaheadPage.findByText(/no one matches/i)).toHaveTextContent(
      /zzz/,
    )
  })

  it('renders results as a listbox of options (#94)', async () => {
    const { options } = await openWithResults()

    expect(opponentTypeaheadPage.queryListbox()).toBeInTheDocument()
    expect(options).toHaveLength(3)
    // First option is active by default and the combobox points at it.
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
    expect(opponentTypeaheadPage.activeDescendantId()).toBe(options[0].id)
  })

  it('moves the active option with ArrowDown / ArrowUp and tracks it via aria-activedescendant (#94)', async () => {
    const { user, options } = await openWithResults()
    const combobox = opponentTypeaheadPage.getCombobox()

    await user.keyboard('{ArrowDown}')
    expect(options[1]).toHaveAttribute('aria-selected', 'true')
    expect(opponentTypeaheadPage.activeDescendantId()).toBe(options[1].id)

    await user.keyboard('{ArrowUp}')
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
    expect(opponentTypeaheadPage.activeDescendantId()).toBe(options[0].id)
    expect(combobox).toHaveFocus()
  })

  it('does not move past the last option on ArrowDown', async () => {
    const { user, options } = await openWithResults()

    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}')
    expect(options[2]).toHaveAttribute('aria-selected', 'true')
  })

  it('jumps to the last option with End and the first with Home (#100)', async () => {
    const { user, options } = await openWithResults()

    await user.keyboard('{End}')
    expect(options[2]).toHaveAttribute('aria-selected', 'true')

    await user.keyboard('{Home}')
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
  })

  it('selects the active option on Enter', async () => {
    const user = userEvent.setup()
    let picked: string | null = null
    opponentTypeaheadPage.mockSearch(() => HttpResponse.json(THREE_PLAYERS))
    opponentTypeaheadPage.render({ onPick: (p) => (picked = p.username) })

    await user.type(opponentTypeaheadPage.getCombobox(), 'a')
    await opponentTypeaheadPage.findOption(/ada\.lovelace/)
    await user.keyboard('{ArrowDown}{Enter}')

    expect(picked).toBe('grace.hopper')
  })

  it('hides the listbox on Escape without clearing the query, and reopens on ArrowDown (#97)', async () => {
    const { user } = await openWithResults()
    const combobox = opponentTypeaheadPage.getCombobox()

    await user.keyboard('{Escape}')
    expect(opponentTypeaheadPage.queryListbox()).not.toBeInTheDocument()
    // The typed query survives — not a dead end.
    expect(combobox).toHaveValue('a')
    expect(combobox).toHaveAttribute('aria-expanded', 'false')

    await user.keyboard('{ArrowDown}')
    expect(opponentTypeaheadPage.queryListbox()).toBeInTheDocument()
    expect(combobox).toHaveAttribute('aria-expanded', 'true')
  })

  it('focuses the input only when opened for the first time (#131)', () => {
    opponentTypeaheadPage.render({ autoFocus: true })
    expect(opponentTypeaheadPage.getCombobox()).toHaveFocus()
  })

  it('does not steal focus on a plain mount (#131)', () => {
    opponentTypeaheadPage.render({ autoFocus: false })
    expect(opponentTypeaheadPage.getCombobox()).not.toHaveFocus()
  })

  it('clears the query from the clear button', async () => {
    const user = userEvent.setup()
    opponentTypeaheadPage.mockSearch(() => HttpResponse.json(THREE_PLAYERS))
    opponentTypeaheadPage.render()

    const combobox = opponentTypeaheadPage.getCombobox()
    await user.type(combobox, 'ada')
    expect(opponentTypeaheadPage.queryClearButton()).toBeInTheDocument()

    await user.click(opponentTypeaheadPage.queryClearButton()!)
    expect(combobox).toHaveValue('')
  })
})
