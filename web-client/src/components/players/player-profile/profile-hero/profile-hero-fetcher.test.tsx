import { HttpResponse } from 'msw'

import { buildPlayerDetail } from '@/mocks/factories/players/player-detail.factory'
import { waitForElementToBeRemoved } from '@/test/utilities'

import { profileHeroFetcherPage } from './profile-hero-fetcher.page'

describe('ProfileHeroFetcher', () => {
  it('suspends until the bundle resolves, showing no name before data', async () => {
    profileHeroFetcherPage.mockEndpoint(() =>
      HttpResponse.json(buildPlayerDetail({ username: 'rita.kovac' })),
    )

    profileHeroFetcherPage.render()

    expect(profileHeroFetcherPage.queryLoading()).toBeInTheDocument()
    expect(profileHeroFetcherPage.queryName('rita.kovac')).not.toBeInTheDocument()

    await waitForElementToBeRemoved(profileHeroFetcherPage.queryLoading())
    expect(profileHeroFetcherPage.queryName('rita.kovac')).toBeInTheDocument()
  })

  it('hands the projected identity to the display', async () => {
    profileHeroFetcherPage.mockEndpoint(() =>
      HttpResponse.json(
        buildPlayerDetail({
          username: 'leo.mertens',
          member_since: '2023-11-02T12:00:00Z',
        }),
      ),
    )

    profileHeroFetcherPage.render()

    await waitForElementToBeRemoved(profileHeroFetcherPage.queryLoading())
    expect(profileHeroFetcherPage.getName('leo.mertens')).toBeInTheDocument()
    expect(profileHeroFetcherPage.queryMemberSince()).toHaveTextContent(
      'Member since Nov 2023',
    )
  })

  it('propagates a failed bundle to the ancestor error boundary', async () => {
    // No per-card boundary by design: all the profile's cards share this one
    // query, so a failure has nothing to draw and belongs to the route.
    profileHeroFetcherPage.mockEndpoint(
      () => new HttpResponse(null, { status: 500 }),
    )

    profileHeroFetcherPage.render()

    await waitForElementToBeRemoved(profileHeroFetcherPage.queryLoading())
    expect(profileHeroFetcherPage.queryError()).toBeInTheDocument()
  })
})
