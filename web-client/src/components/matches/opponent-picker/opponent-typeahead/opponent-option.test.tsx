import userEvent from '@testing-library/user-event'

import { fireEvent } from '@/test/utilities'

import { buildPlayer } from '@/mocks/factories/players/player.factory'

import { opponentOptionPage } from './opponent-option.page'

describe('OpponentOption', () => {
  it('exposes a combobox option whose accessible name is the player + role (#94/#99)', () => {
    opponentOptionPage.render({
      player: buildPlayer({ username: 'grace.hopper', rating: 1500 }),
    })

    const option = opponentOptionPage.getOption('grace.hopper, RATING 1500')
    expect(option).toHaveAttribute('role', 'option')
    // The decorative avatar initials are not part of the accessible name.
    expect(option).toHaveAccessibleName('grace.hopper, RATING 1500')
  })

  it('shows the active highlight without announcing itself as selected (#894)', () => {
    // The keyboard/hover highlight is *not* a selection: it reaches assistive
    // tech as the combobox's aria-activedescendant, and an option that merely
    // has the cursor on it must keep saying it is unselected — otherwise the
    // typeahead announces an opponent the match has not been given.
    opponentOptionPage.render({
      player: buildPlayer({ username: 'grace.hopper' }),
      active: true,
    })

    const option = opponentOptionPage.getOption(/grace\.hopper/)
    expect(option).toHaveClass('active')
    expect(option).toHaveAttribute('aria-selected', 'false')
  })

  it('marks itself unselected and unhighlighted when inactive', () => {
    opponentOptionPage.render({ active: false })

    const option = opponentOptionPage.getOption(/ada\.lovelace/)
    expect(option).toHaveAttribute('aria-selected', 'false')
    expect(option).not.toHaveClass('active')
  })

  it('renders a readable fallback name for a blank username (#101)', () => {
    opponentOptionPage.render({
      player: buildPlayer({ username: '', rating: null }),
    })

    expect(
      opponentOptionPage.getOption('Unnamed player, REGISTERED PLAYER'),
    ).toBeInTheDocument()
  })

  it('selects the player on click', async () => {
    const user = userEvent.setup()
    let picked = false
    opponentOptionPage.render({ onPick: () => (picked = true) })

    await user.click(opponentOptionPage.getOption(/ada\.lovelace/))
    expect(picked).toBe(true)
  })

  it('activates on real cursor movement, not a stationary re-render (#132)', () => {
    let hovered = false
    opponentOptionPage.render({ onHover: () => (hovered = true) })
    const option = opponentOptionPage.getOption(/ada\.lovelace/)

    // mouseEnter alone (cursor entering because rows shifted under it) is ignored.
    fireEvent.mouseEnter(option)
    expect(hovered).toBe(false)

    // Only a genuine mousemove sets the active option.
    fireEvent.mouseMove(option)
    expect(hovered).toBe(true)
  })
})
