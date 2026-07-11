import { HttpResponse } from 'msw'

import { playerByIdQueryOptions } from '@/api/players'
import {
  buildFirmingUpConfidence,
  buildPlayerDetail,
  buildProvisionalConfidence,
  buildRatingConfidence,
  buildUnratedPlayerDetail,
} from '@/mocks/factories/players/player-detail.factory'
import { waitFor } from '@/test/utilities'

import {
  confidenceCardQuery,
  type ConfidenceView,
} from './confidence-card-query'
import { confidenceCardQueryPage } from './confidence-card-query.page'

/** Resolve the query against one bundle and hand back the projected view. */
async function selectFrom(
  overrides: Parameters<typeof buildPlayerDetail>[0],
): Promise<ConfidenceView | null> {
  confidenceCardQueryPage.mockEndpoint(() =>
    HttpResponse.json(buildPlayerDetail(overrides)),
  )
  const { result } = confidenceCardQueryPage.render()
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  return result.current.data!
}

const detailValue = (view: ConfidenceView, label: string) =>
  view.details.find((detail) => detail.label === label)?.value

describe('confidenceCardQuery', () => {
  it('names the level in English — "Firming up", never the wire’s "firming_up"', async () => {
    const firming = await selectFrom({
      confidence: buildFirmingUpConfidence(),
    })
    expect(firming!.levelLabel).toBe('Firming up')
    expect(firming!.levelLabel).not.toContain('_')

    const provisional = await selectFrom({
      confidence: buildProvisionalConfidence(),
    })
    expect(provisional!.levelLabel).toBe('Provisional')

    const settled = await selectFrom({
      confidence: buildRatingConfidence({ level: 'settled' }),
    })
    expect(settled!.levelLabel).toBe('Settled')
  })

  it('reads the 95% interval the API sent, in whole rating points', async () => {
    // The interval is the card's one rigorous statement, and it arrives
    // pre-computed (`rating ± 1.96·RD`) — a client that derived it would be a
    // second, drifting definition of the same fact.
    const view = await selectFrom({
      rating: 1687,
      confidence: buildRatingConfidence({
        deviation: 69.4,
        interval: { low: 1551.4, high: 1823.2 },
      }),
    })

    expect(view!.interval).toEqual({ low: '1551', high: '1823' })
  })

  it('keeps deviation and volatility as the drawer’s two labelled numbers', async () => {
    // RD and sigma are the internals BEHIND confidence, not names for it
    // (CONTEXT.md) — so they are labelled as what they are and kept off the face.
    const view = await selectFrom({
      confidence: buildRatingConfidence({ deviation: 69.4, volatility: 0.0592 }),
    })

    expect(detailValue(view!, 'Deviation (RD)')).toBe('69.4')
    expect(detailValue(view!, 'Volatility (σ)')).toBe('0.0592')
  })

  it('projects NOTHING — not an empty card — for a player with no rating', async () => {
    // Confidence says how settled a *rating* is. A player who has never finished
    // a rated match has none, so there is nothing to be confident about: the API
    // sends null and the card must not render at all.
    const view = await selectFrom(buildUnratedPlayerDetail())

    expect(view).toBeNull()
  })

  it('projects nothing when the bundle OMITS confidence, not just when it nulls it', async () => {
    // The field is optional *and* nullable on the wire, so an absent one must not
    // slip through a `=== null` check and crash the card on `undefined.interval`.
    const view = await selectFrom({ confidence: undefined })

    expect(view).toBeNull()
  })

  it('invents no confidence PERCENTAGE — there is no such number', async () => {
    // An earlier design had an "86%" bar. It was cut: it is an arbitrary
    // rescaling of RD onto a 0–100 axis that says nothing the level and the
    // interval don't say better (CONTEXT.md). Nothing in the view may carry one.
    const view = await selectFrom({ confidence: buildRatingConfidence() })

    const printed = JSON.stringify(view)
    expect(printed).not.toContain('%')
    expect(Object.keys(view!)).not.toContain('percent')
    expect(Object.keys(view!)).not.toContain('percentage')
    expect(Object.keys(view!)).not.toContain('score')
  })

  it('reads the same cache entry as the profile bundle — no second request', () => {
    // The projection pattern's whole promise: same key, same fetch, a different
    // view. A key that forked here would silently double the page's network cost
    // (and the profile's "exactly one bundle request" test would catch it).
    expect(confidenceCardQuery('p-1').queryKey).toEqual(
      playerByIdQueryOptions('p-1').queryKey,
    )
  })

  it('does not key the cache on WHO is looking — the viewer changes pronouns, not numbers', () => {
    // Viewer-awareness (ADR-0915) is a display concern. If it ever leaked into
    // the key, one player's bundle would fork into two identical entries and the
    // page would fetch twice on your own profile.
    //
    // The trailing `null` is the *league* — a fact about the ladder, which very
    // much does belong in the key (ADR-0915). `null` is the default league, i.e.
    // a URL with no `?league=`. Contrast it with the viewer, which appears here
    // nowhere.
    expect(confidenceCardQuery('p-1').queryKey).toEqual([
      'players',
      'detail',
      'p-1',
      null,
    ])
  })
})
