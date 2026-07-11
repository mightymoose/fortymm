import { HttpResponse, delay } from 'msw'

import {
  buildPlayerDetail,
  buildProvisionalConfidence,
  buildRatingConfidence,
  buildUnratedPlayerDetail,
} from '@/mocks/factories/players/player-detail.factory'
import { waitFor, waitForElementToBeRemoved } from '@/test/utilities'

import { confidenceCardFetcherPage } from './confidence-card-fetcher.page'

const PROFILE_ID = 'p-1'
const SOMEONE_ELSE = 'p-9'

describe('ConfidenceCardFetcher', () => {
  it('suspends until the bundle resolves, then paints the level and interval it carries', async () => {
    // The numbers ride on the bundle — the card makes no request of its own, and
    // anything else would be unhandled and MSW would fail the test.
    confidenceCardFetcherPage.signInAs(SOMEONE_ELSE)
    confidenceCardFetcherPage.mockEndpoint(async () => {
      await delay(20)
      return HttpResponse.json(
        buildPlayerDetail({
          id: PROFILE_ID,
          rating: 1687,
          confidence: buildRatingConfidence({
            level: 'settled',
            deviation: 69.4,
            volatility: 0.0592,
            interval: { low: 1551, high: 1823 },
          }),
        }),
      )
    })

    confidenceCardFetcherPage.render({ playerId: PROFILE_ID })

    await confidenceCardFetcherPage.findLoading()
    await waitForElementToBeRemoved(confidenceCardFetcherPage.queryLoading())

    expect(confidenceCardFetcherPage.getConfidenceLevel()).toHaveTextContent(
      'Settled',
    )
    expect(confidenceCardFetcherPage.getConfidenceInterval()).toHaveTextContent(
      'We think they’re somewhere between 1551 and 1823.',
    )
    expect(
      confidenceCardFetcherPage.queryConfidenceDetail('Deviation (RD)'),
    ).toHaveTextContent('69.4')
  })

  it('speaks in the THIRD person on somebody else’s profile', async () => {
    // The viewer is p-9; the profile is p-1. "A reliable read on where you stand"
    // here would be a lie about a stranger's rating.
    confidenceCardFetcherPage.signInAs(SOMEONE_ELSE)
    confidenceCardFetcherPage.mockEndpoint(() =>
      HttpResponse.json(buildPlayerDetail({ id: PROFILE_ID })),
    )

    confidenceCardFetcherPage.render({ playerId: PROFILE_ID })

    const card = await confidenceCardFetcherPage.findConfidenceCard()
    expect(
      confidenceCardFetcherPage.getConfidenceExplanation(),
    ).toHaveTextContent('A reliable read on where they stand. The math is quiet.')
    // Give the session every chance to arrive and wrongly flip the voice.
    await waitFor(() => expect(card.textContent).not.toMatch(/\byou\b/i))
  })

  it('speaks in the SECOND person on your own profile — the session says it is yours', async () => {
    // Same bundle, same numbers, different reader: the session's own user id is
    // this profile's id, so the copy turns to "you" (ADR-0915).
    confidenceCardFetcherPage.signInAs(PROFILE_ID)
    confidenceCardFetcherPage.mockEndpoint(() =>
      HttpResponse.json(buildPlayerDetail({ id: PROFILE_ID })),
    )

    confidenceCardFetcherPage.render({ playerId: PROFILE_ID })

    await confidenceCardFetcherPage.findConfidenceCard()
    // The session is a plain query, so the voice settles a tick after the card
    // paints — third person is the safe default to be caught in.
    await waitFor(() =>
      expect(
        confidenceCardFetcherPage.getConfidenceExplanation(),
      ).toHaveTextContent('A reliable read on where you stand. The math is quiet.'),
    )
    expect(confidenceCardFetcherPage.getConfidenceInterval()).toHaveTextContent(
      'We think you’re somewhere between 1551 and 1823.',
    )
  })

  it('renders NOTHING AT ALL for a player with no rating', async () => {
    // Not an empty card, not a dash: no card. Confidence says how settled a
    // rating is, and this player has none — the hero already says "Unrated".
    confidenceCardFetcherPage.signInAs(SOMEONE_ELSE)
    confidenceCardFetcherPage.mockEndpoint(() =>
      HttpResponse.json(buildUnratedPlayerDetail({ id: PROFILE_ID })),
    )

    confidenceCardFetcherPage.render({ playerId: PROFILE_ID })

    await waitFor(() =>
      expect(confidenceCardFetcherPage.queryLoading()).not.toBeInTheDocument(),
    )
    expect(
      confidenceCardFetcherPage.queryConfidenceCard(),
    ).not.toBeInTheDocument()
    // …and it is *absent*, not *crashed*: a card that threw on the null would
    // also leave no region behind.
    expect(confidenceCardFetcherPage.queryError()).not.toBeInTheDocument()
  })

  it('still renders for a PROVISIONAL rating — a wide interval is a real answer', async () => {
    // The null case above is about having no rating at all. A rating the system
    // is unsure of is exactly what this card is for, so it must still appear.
    confidenceCardFetcherPage.signInAs(SOMEONE_ELSE)
    confidenceCardFetcherPage.mockEndpoint(() =>
      HttpResponse.json(
        buildPlayerDetail({
          id: PROFILE_ID,
          confidence: buildProvisionalConfidence(),
        }),
      ),
    )

    confidenceCardFetcherPage.render({ playerId: PROFILE_ID })

    await confidenceCardFetcherPage.findConfidenceCard()
    expect(confidenceCardFetcherPage.getConfidenceLevel()).toHaveTextContent(
      'Provisional',
    )
    expect(
      confidenceCardFetcherPage.getConfidenceExplanation(),
    ).toHaveTextContent('We’re still working out where they belong. Expect big swings.')
    expect(confidenceCardFetcherPage.getConfidenceInterval()).toHaveTextContent(
      'between 1088 and 1912',
    )
  })

  it('propagates a failed bundle to the ancestor error boundary', async () => {
    // No per-card boundary by design: every card shares this one query.
    confidenceCardFetcherPage.mockEndpoint(
      () => new HttpResponse(null, { status: 500 }),
    )

    confidenceCardFetcherPage.render({ playerId: PROFILE_ID })

    expect(await confidenceCardFetcherPage.findError()).toBeInTheDocument()
    expect(confidenceCardFetcherPage.queryLoading()).not.toBeInTheDocument()
  })
})
