import { HttpResponse } from 'msw'

import { playerByIdQueryOptions } from '@/api/players'
import {
  buildPlayerDetail,
  buildRatingChange,
  buildUnratedPlayerDetail,
} from '@/mocks/factories/players/player-detail.factory'
import { waitFor } from '@/test/utilities'

import { ratingPanelQuery, type RatingPanelView } from './rating-panel-query'
import { ratingPanelQueryPage } from './rating-panel-query.page'

/** Resolve the query against one bundle and hand back the projected view. */
async function selectFrom(
  overrides: Parameters<typeof buildPlayerDetail>[0],
): Promise<RatingPanelView> {
  ratingPanelQueryPage.mockEndpoint(() =>
    HttpResponse.json(buildPlayerDetail(overrides)),
  )
  const { result } = ratingPanelQueryPage.render()
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  return result.current.data!
}

describe('ratingPanelQuery', () => {
  it('rounds the rating to a whole number', async () => {
    const view = await selectFrom({ rating: 1686.6 })

    expect(view.rating).toBe(1687)
  })

  it('reports the rank against the size of the rated ladder', async () => {
    // Never a naked "#3": in a twelve-player league that flatters. The ladder
    // size is what makes the rank honest.
    const view = await selectFrom({ rank: 3, rank_of: 42 })

    expect(view.stats).toContainEqual({ label: 'Rank', value: '#3 of 42' })
  })

  it('withholds the rank when the ladder size is unknown', async () => {
    const view = await selectFrom({ rank: 3, rank_of: null })

    expect(view.stats.map((s) => s.label)).not.toContain('Rank')
  })

  it('rounds the peak rating', async () => {
    const view = await selectFrom({ peak: 1711.8 })

    expect(view.stats).toContainEqual({ label: 'Peak', value: '1712' })
  })

  it('shows a percentile only when the API sends one', async () => {
    const withheld = await selectFrom({ percentile: null })
    expect(withheld.stats.map((s) => s.label)).not.toContain('Percentile')

    const given = await selectFrom({ percentile: 8 })
    expect(given.stats).toContainEqual({
      label: 'Percentile',
      value: 'Top 8%',
    })
  })

  it('signs the rating delta from the most recent rated match', async () => {
    const view = await selectFrom({
      rating_delta: buildRatingChange({ before: 1675, after: 1687, delta: 12 }),
    })

    expect(view.delta).toEqual({
      label: '+12',
      ariaLabel: 'Gained 12 rating',
      tone: 'win',
    })
  })

  it('tones a losing delta as a loss', async () => {
    const view = await selectFrom({
      rating_delta: buildRatingChange({ before: 1695, after: 1687, delta: -8 }),
    })

    expect(view.delta?.label).toBe('-8')
    expect(view.delta?.tone).toBe('loss')
  })

  it('has NO delta — not a "+0" — when no rated match has moved the rating', async () => {
    const view = await selectFrom({ rating_delta: null })

    expect(view.delta).toBeNull()
  })

  it('projects all ten form results, newest first', async () => {
    const view = await selectFrom({ form: 'WWLWLLWWLW' })

    expect(view.form?.results).toEqual([
      'W',
      'W',
      'L',
      'W',
      'L',
      'L',
      'W',
      'W',
      'L',
      'W',
    ])
    expect(view.form?.label).toBe('Last 10: W W L W L L W W L W')
  })

  it('labels a short form by what it actually holds', async () => {
    const view = await selectFrom({ form: 'WL' })

    expect(view.form?.label).toBe('Last 2: W L')
  })

  it('has no form for a player with no decided matches', async () => {
    const view = await selectFrom({ form: '' })

    expect(view.form).toBeNull()
  })

  it('gives an unrated player no rating, no rank, no peak and no delta', async () => {
    // No rating, no rank (CONTEXT.md § Rank) — and so nothing to peak at and
    // nothing to have moved.
    ratingPanelQueryPage.mockEndpoint(() =>
      HttpResponse.json(buildUnratedPlayerDetail({ form: 'WL' })),
    )
    const { result } = ratingPanelQueryPage.render()
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    const view = result.current.data!
    expect(view.rating).toBeNull()
    expect(view.stats).toEqual([])
    expect(view.delta).toBeNull()
    // …but form survives: it counts decided matches, rated or not.
    expect(view.form?.results).toEqual(['W', 'L'])
  })

  it('reads the same cache entry as the profile bundle — no second request', () => {
    expect(ratingPanelQuery('p-1').queryKey).toEqual(
      playerByIdQueryOptions('p-1').queryKey,
    )
  })
})
