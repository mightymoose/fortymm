import { HttpResponse } from 'msw'
import userEvent from '@testing-library/user-event'

import { buildPlayer } from '@/mocks/factories/players/player.factory'
import { fireEvent } from '@/test/utilities'

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
  })

  it('highlights no option when results arrive, until the user navigates (#894)', async () => {
    // Results appearing is not a choice. Nobody asked for the first row, so it
    // must not sit there looking picked while the card upstream still has no
    // opponent.
    const { user, options } = await openWithResults()

    expect(opponentTypeaheadPage.getHighlightedOptions()).toHaveLength(0)
    expect(opponentTypeaheadPage.activeDescendantId()).toBeNull()

    // Arrowing in is the first act of intent — now, and only now, row 1 lights up.
    await user.keyboard('{ArrowDown}')
    expect(opponentTypeaheadPage.getHighlightedOptions()).toEqual([options[0]])
    expect(opponentTypeaheadPage.activeDescendantId()).toBe(options[0].id)
  })

  it('highlights the row the cursor moves over, without selecting it (#894)', async () => {
    const { options } = await openWithResults()

    fireEvent.mouseMove(options[2])

    expect(opponentTypeaheadPage.getHighlightedOptions()).toEqual([options[2]])
    expect(opponentTypeaheadPage.activeDescendantId()).toBe(options[2].id)
    expect(opponentTypeaheadPage.getSelectedOptions()).toHaveLength(0)
  })

  it('re-arms to no highlight on the next keystroke (#894)', async () => {
    const { user, options } = await openWithResults()

    await user.keyboard('{ArrowDown}')
    expect(opponentTypeaheadPage.getHighlightedOptions()).toEqual([options[0]])

    // Typing on means the hunt is still on: the previous highlight is dropped
    // rather than silently re-pointed at whatever now sits in that slot.
    await user.type(opponentTypeaheadPage.getCombobox(), 'd')
    expect(opponentTypeaheadPage.getHighlightedOptions()).toHaveLength(0)
    expect(opponentTypeaheadPage.activeDescendantId()).toBeNull()
  })

  it('never announces a highlighted-but-uncommitted option as selected (#894)', async () => {
    // The highlight is published on the combobox via aria-activedescendant —
    // the ARIA 1.2 combobox pattern — and never as aria-selected on the option,
    // which would tell a screen reader an opponent had been chosen.
    const { user, options } = await openWithResults()

    await user.keyboard('{ArrowDown}{ArrowDown}')

    expect(opponentTypeaheadPage.getHighlightedOptions()).toEqual([options[1]])
    expect(opponentTypeaheadPage.activeDescendantId()).toBe(options[1].id)
    expect(opponentTypeaheadPage.getSelectedOptions()).toHaveLength(0)
  })

  it('moves the active option with ArrowDown / ArrowUp and tracks it via aria-activedescendant (#94)', async () => {
    const { user, options } = await openWithResults()
    const combobox = opponentTypeaheadPage.getCombobox()

    await user.keyboard('{ArrowDown}{ArrowDown}')
    expect(opponentTypeaheadPage.activeDescendantId()).toBe(options[1].id)
    expect(opponentTypeaheadPage.getHighlightedOptions()).toEqual([options[1]])

    await user.keyboard('{ArrowUp}')
    expect(opponentTypeaheadPage.activeDescendantId()).toBe(options[0].id)
    expect(opponentTypeaheadPage.getHighlightedOptions()).toEqual([options[0]])
    expect(combobox).toHaveFocus()
  })

  it('wraps ArrowUp from no highlight round to the last option', async () => {
    const { user, options } = await openWithResults()

    await user.keyboard('{ArrowUp}')
    expect(opponentTypeaheadPage.activeDescendantId()).toBe(options[2].id)
  })

  it('does not move past the last option on ArrowDown', async () => {
    const { user, options } = await openWithResults()

    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}')
    expect(opponentTypeaheadPage.activeDescendantId()).toBe(options[2].id)
  })

  it('jumps to the last option with End and the first with Home (#100)', async () => {
    const { user, options } = await openWithResults()

    await user.keyboard('{End}')
    expect(opponentTypeaheadPage.activeDescendantId()).toBe(options[2].id)

    await user.keyboard('{Home}')
    expect(opponentTypeaheadPage.activeDescendantId()).toBe(options[0].id)
  })

  it('selects the active option on Enter', async () => {
    const user = userEvent.setup()
    let picked: string | null = null
    opponentTypeaheadPage.mockSearch(() => HttpResponse.json(THREE_PLAYERS))
    opponentTypeaheadPage.render({ onPick: (p) => (picked = p.username) })

    await user.type(opponentTypeaheadPage.getCombobox(), 'a')
    await opponentTypeaheadPage.findOption(/ada\.lovelace/)
    // Two ArrowDowns: the first highlights row 1, the second moves to row 2.
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}')

    expect(picked).toBe('grace.hopper')
  })

  it('picks nobody on Enter while no option is highlighted (#894)', async () => {
    const user = userEvent.setup()
    let picked: string | null = null
    opponentTypeaheadPage.mockSearch(() => HttpResponse.json(THREE_PLAYERS))
    opponentTypeaheadPage.render({ onPick: (p) => (picked = p.username) })

    await user.type(opponentTypeaheadPage.getCombobox(), 'a')
    await opponentTypeaheadPage.findOption(/ada\.lovelace/)
    await user.keyboard('{Enter}')

    // Enter commits the *highlighted* option; with none highlighted and several
    // to choose between, it commits nothing — it must not quietly pick whoever
    // happens to be first.
    expect(picked).toBeNull()
  })

  it('takes the only candidate on Enter — one result is not ambiguous (#894)', async () => {
    const user = userEvent.setup()
    let picked: string | null = null
    opponentTypeaheadPage.mockSearch(() =>
      HttpResponse.json([buildPlayer({ id: 'pl-1', username: 'ada.lovelace' })]),
    )
    opponentTypeaheadPage.render({ onPick: (p) => (picked = p.username) })

    await user.type(opponentTypeaheadPage.getCombobox(), 'ada.lovelace')
    await opponentTypeaheadPage.findOption(/ada\.lovelace/)
    await user.keyboard('{Enter}')

    // Typing a name you already know and pressing Enter is the ordinary
    // keyboard path. Refusing to auto-highlight (#894) must not turn that into
    // a dead key: with a single candidate there is nothing to disambiguate.
    expect(picked).toBe('ada.lovelace')
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
