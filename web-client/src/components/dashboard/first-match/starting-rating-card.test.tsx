import { userEvent } from '@testing-library/user-event'

import { startingRatingCardPage } from './starting-rating-card.page'

describe('StartingRatingCard', () => {
  it('shows the seeded 1500 rating as provisional', () => {
    startingRatingCardPage.render()

    expect(startingRatingCardPage.getRating()).toBeInTheDocument()
    expect(startingRatingCardPage.getProvisionalBadge()).toBeInTheDocument()
  })

  it('hides the RD explainer until expanded', () => {
    startingRatingCardPage.render()

    expect(startingRatingCardPage.queryRdText()).not.toBeInTheDocument()
  })

  it('reveals the confidence explainer on toggle', async () => {
    startingRatingCardPage.render()

    await userEvent.click(startingRatingCardPage.getExplainerTrigger())

    expect(startingRatingCardPage.queryRdText()).toBeInTheDocument()
  })
})
