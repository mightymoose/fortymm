import { noMatchesCardPage } from './no-matches-card.page'

describe('NoMatchesCard', () => {
  it('renders the friendlier zero-match empty state', () => {
    noMatchesCardPage.render()

    expect(noMatchesCardPage.getOverline()).toBeInTheDocument()
    expect(noMatchesCardPage.getHeadline()).toBeInTheDocument()
  })
})
