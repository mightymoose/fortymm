import userEvent from '@testing-library/user-event'

import { buildEvent } from '../../data/seed.factory'
import { matchSectionPage } from './match-section.page'

describe('MatchSection', () => {
  it('reflects the current rated state', () => {
    matchSectionPage.render({
      event: buildEvent({ match: { rated: false, lengthGames: 3 } }),
    })
    expect(matchSectionPage.getRatedSwitch()).not.toBeChecked()
  })

  it('toggles rated off', async () => {
    const onChange = vi.fn()
    matchSectionPage.render({
      event: buildEvent({ match: { rated: true, lengthGames: 5 } }),
      onChange,
    })
    await userEvent.click(matchSectionPage.getRatedSwitch())
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ match: { rated: false, lengthGames: 5 } }),
    )
  })

  it('changes the best-of length', async () => {
    const onChange = vi.fn()
    matchSectionPage.render({
      event: buildEvent({ match: { rated: true, lengthGames: 5 } }),
      onChange,
    })
    await userEvent.click(matchSectionPage.getLengthOption('Bo7'))
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ match: { rated: true, lengthGames: 7 } }),
    )
  })
})
