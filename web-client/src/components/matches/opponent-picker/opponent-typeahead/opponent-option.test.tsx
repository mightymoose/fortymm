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

  it('reflects the active state via aria-selected and the active class (#94)', () => {
    opponentOptionPage.render({
      player: buildPlayer({ username: 'grace.hopper' }),
      active: true,
    })

    const option = opponentOptionPage.getOption(/grace\.hopper/)
    expect(option).toHaveAttribute('aria-selected', 'true')
    expect(option).toHaveClass('active')
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
