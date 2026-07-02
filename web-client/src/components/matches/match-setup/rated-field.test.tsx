import { userEvent } from '@testing-library/user-event'

import { ratedFieldPage } from './rated-field.page'

describe('RatedField', () => {
  it('is disabled with an explainer when no opponent is picked', async () => {
    ratedFieldPage.render({ opponent: null, rated: false })

    const toggle = await ratedFieldPage.findSwitch()
    expect(toggle).toBeDisabled()
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(
      await ratedFieldPage.findDescription('Pick an opponent to make this rated.'),
    ).toBeInTheDocument()
    expect(ratedFieldPage.queryUnavailableBadge()).toBeInTheDocument()
  })

  it('is off but enabled for an unrated match with an opponent', async () => {
    ratedFieldPage.render({ rated: false })

    const toggle = await ratedFieldPage.findSwitch()
    expect(toggle).toBeEnabled()
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(
      await ratedFieldPage.findDescription(
        'No rating change. Still logged to history.',
      ),
    ).toBeInTheDocument()
    expect(ratedFieldPage.queryUnavailableBadge()).not.toBeInTheDocument()
  })

  it('shows the rated description and a guest hint when on and the user is a guest', async () => {
    ratedFieldPage.render({ rated: true, isGuest: true })

    const toggle = await ratedFieldPage.findSwitch()
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(
      await ratedFieldPage.findDescription('Result will update both ratings.'),
    ).toBeInTheDocument()
    const link = ratedFieldPage.queryGuestLink()
    expect(link).toBeInTheDocument()
    expect(link).toHaveAttribute('href', '/settings#sec-email')
  })

  it('hides the guest hint for a non-guest even when rated', async () => {
    ratedFieldPage.render({ rated: true, isGuest: false })

    await ratedFieldPage.findSwitch()
    expect(ratedFieldPage.queryGuestLink()).not.toBeInTheDocument()
  })

  it('toggles rated on click when ratable', async () => {
    const setRated = vi.fn()
    ratedFieldPage.render({ rated: false, setRated })

    await userEvent.click(await ratedFieldPage.findSwitch())

    expect(setRated).toHaveBeenCalledWith(true)
  })

  it('does not toggle when disabled (no opponent)', async () => {
    const setRated = vi.fn()
    ratedFieldPage.render({ opponent: null, rated: false, setRated })

    await userEvent.click(await ratedFieldPage.findSwitch())

    expect(setRated).not.toHaveBeenCalled()
  })
})
