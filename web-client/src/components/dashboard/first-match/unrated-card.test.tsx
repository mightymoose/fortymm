import { userEvent } from '@testing-library/user-event'

import { unratedCardPage } from './unrated-card.page'

describe('UnratedCard', () => {
  it('says the player is unrated instead of quoting a rating', () => {
    unratedCardPage.render()

    expect(unratedCardPage.getUnratedHeadline()).toBeInTheDocument()
    expect(unratedCardPage.queryRatingNumber()).not.toBeInTheDocument()
    expect(unratedCardPage.queryProvisionalBadge()).not.toBeInTheDocument()
  })

  it('hides the ladder explainer until expanded', () => {
    unratedCardPage.render()

    expect(unratedCardPage.queryExplainerBody()).not.toBeInTheDocument()
  })

  it('explains the ladder on toggle — still without quoting a number', async () => {
    unratedCardPage.render()

    await userEvent.click(unratedCardPage.getExplainerTrigger())

    expect(unratedCardPage.queryExplainerBody()).toBeInTheDocument()
    // The old card's explainer put "RD 350" and a confidence meter in here. An
    // explanation of the mechanism is honest onboarding; a confidence level
    // about a rating this player does not have is not.
    expect(unratedCardPage.queryRatingNumber()).not.toBeInTheDocument()
  })
})
