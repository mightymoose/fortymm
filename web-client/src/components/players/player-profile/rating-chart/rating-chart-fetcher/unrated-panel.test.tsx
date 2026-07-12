import { screen } from '@/test/utilities'

import { unratedPanelPage } from './unrated-panel.page'

describe('UnratedPanel', () => {
  it('says what is true, and what would end it', () => {
    // Not an empty chart. A rating chart is a picture of a rating moving, and this
    // player has no rating — an axis with no line would be fiction.
    unratedPanelPage.render()

    expect(unratedPanelPage.queryUnratedPanel()).toBeInTheDocument()
  })

  it('draws no line, and offers no range to draw one over', () => {
    unratedPanelPage.render()

    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: '30d' })).not.toBeInTheDocument()
  })
})
