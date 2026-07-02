import { userEvent } from '@testing-library/user-event'

import { buildOpponent } from './selected-opponent.factory'
import { selectedOpponentPage } from './selected-opponent.page'

describe('SelectedOpponent', () => {
  it('renders the opponent name and their rating', () => {
    selectedOpponentPage.render({
      opponent: buildOpponent({ name: 'silva.r', rating: 1612 }),
    })

    expect(selectedOpponentPage.getName('silva.r')).toBeInTheDocument()
    expect(selectedOpponentPage.getRoleLabel('RATING 1612')).toBeInTheDocument()
  })

  it('falls back to the generic role label for an unrated opponent', () => {
    selectedOpponentPage.render({
      opponent: buildOpponent({ name: 'patel.m', rating: null }),
    })

    expect(
      selectedOpponentPage.getRoleLabel('REGISTERED PLAYER'),
    ).toBeInTheDocument()
  })

  it('calls onChange when Change is clicked', async () => {
    const onChange = vi.fn()
    selectedOpponentPage.render({ onChange })

    await userEvent.click(selectedOpponentPage.getChangeButton())

    expect(onChange).toHaveBeenCalledOnce()
  })
})
