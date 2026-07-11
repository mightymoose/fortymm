import { HttpResponse } from 'msw'

import { playerByIdQueryOptions } from '@/api/players'
import { buildPlayerDetail } from '@/mocks/factories/players/player-detail.factory'
import { waitFor } from '@/test/utilities'

import { profileHeroQuery } from './profile-hero-query'
import { profileHeroQueryPage } from './profile-hero-query.page'

describe('profileHeroQuery', () => {
  it('projects the username off the profile bundle', async () => {
    profileHeroQueryPage.mockEndpoint(() =>
      HttpResponse.json(buildPlayerDetail({ username: 'rita.kovac' })),
    )

    const { result } = profileHeroQueryPage.render()

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.username).toBe('rita.kovac')
  })

  it('formats the join date as a month and year', async () => {
    profileHeroQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildPlayerDetail({ member_since: '2024-03-14T09:00:00Z' }),
      ),
    )

    const { result } = profileHeroQueryPage.render()

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.memberSince).toBe('Member since Mar 2024')
  })

  it('reads the join month in UTC, not the reader’s timezone', async () => {
    // Midnight UTC on the 1st: in any timezone behind UTC this is still the
    // previous month locally, which would print the wrong month.
    profileHeroQueryPage.mockEndpoint(() =>
      HttpResponse.json(
        buildPlayerDetail({ member_since: '2024-03-01T00:00:00Z' }),
      ),
    )

    const { result } = profileHeroQueryPage.render()

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.memberSince).toBe('Member since Mar 2024')
  })

  it('omits the member-since line when the timestamp is unreadable', async () => {
    profileHeroQueryPage.mockEndpoint(() =>
      HttpResponse.json(buildPlayerDetail({ member_since: 'not-a-date' })),
    )

    const { result } = profileHeroQueryPage.render()

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.memberSince).toBeNull()
  })

  it('reads the same cache entry as the profile bundle — no second request', () => {
    // The whole point of the projection pattern: every card on the profile is a
    // `select` over the bundle's ONE cache entry. If this key ever forks, the
    // page silently fires a second identical request per card.
    expect(profileHeroQuery('p-1').queryKey).toEqual(
      playerByIdQueryOptions('p-1').queryKey,
    )
  })
})
