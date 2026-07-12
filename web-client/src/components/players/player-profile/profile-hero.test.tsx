import { HttpResponse } from 'msw'

import { buildPlayerDetail } from '@/mocks/factories/players/player-detail.factory'
import { waitForElementToBeRemoved } from '@/test/utilities'

import { profileHeroPage } from './profile-hero.page'

describe('ProfileHero', () => {
  it('holds its own skeleton while the bundle loads, then paints the player', async () => {
    profileHeroPage.mockEndpoint(() =>
      HttpResponse.json(buildPlayerDetail({ username: 'rita.kovac' })),
    )

    profileHeroPage.render()

    // The skeleton is the card's real Suspense fallback — announced, not silent.
    expect(profileHeroPage.queryLoading()).toBeInTheDocument()

    await waitForElementToBeRemoved(profileHeroPage.queryLoading())
    expect(profileHeroPage.getName('rita.kovac')).toBeInTheDocument()
  })
})
