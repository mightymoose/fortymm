import { buildFormChipsView } from './rating-panel-display/form-chips.factory'
import {
  buildRatingDeltaView,
  buildRatingPanelView,
  buildStandingStatView,
  buildUnratedRatingPanelView,
} from './rating-panel-display.factory'
import { ratingPanelDisplayPage } from './rating-panel-display.page'

describe('RatingPanelDisplay', () => {
  it('leads with the player’s rating', () => {
    ratingPanelDisplayPage.render({
      standing: buildRatingPanelView({ rating: 1687 }),
    })

    expect(ratingPanelDisplayPage.getRating()).toHaveTextContent('1687')
  })

  it('shows the rating’s recent move as a signed chip', () => {
    ratingPanelDisplayPage.render({
      standing: buildRatingPanelView({
        delta: buildRatingDeltaView({
          label: '-8',
          ariaLabel: 'Lost 8 rating',
          tone: 'loss',
        }),
      }),
    })

    const delta = ratingPanelDisplayPage.queryDelta()
    expect(delta).toHaveTextContent('-8')
    expect(delta).toHaveAttribute('aria-label', 'Lost 8 rating')
  })

  it('renders no delta chip at all when there is no rated match to have moved the rating', () => {
    // The absence must be an absence — a "+0" would claim the rating held
    // steady through a match that never happened.
    ratingPanelDisplayPage.render({
      standing: buildRatingPanelView({ delta: null }),
    })

    expect(ratingPanelDisplayPage.queryDelta()).not.toBeInTheDocument()
  })

  it('reports the rank against the size of the ladder', () => {
    ratingPanelDisplayPage.render({
      standing: buildRatingPanelView({
        stats: [buildStandingStatView({ label: 'Rank', value: '#3 of 42' })],
      }),
    })

    expect(ratingPanelDisplayPage.queryStat('Rank')).toHaveTextContent(
      '#3 of 42',
    )
  })

  it('shows the peak rating', () => {
    ratingPanelDisplayPage.render({
      standing: buildRatingPanelView({
        stats: [buildStandingStatView({ label: 'Peak', value: '1712' })],
      }),
    })

    expect(ratingPanelDisplayPage.queryStat('Peak')).toHaveTextContent('1712')
  })

  it('renders the player’s last ten results', () => {
    ratingPanelDisplayPage.render({
      standing: buildRatingPanelView({ form: buildFormChipsView() }),
    })

    expect(ratingPanelDisplayPage.getChips()).toHaveLength(10)
  })

  it('says "Unrated" and shows no rank for a player who has never finished a rated match', () => {
    ratingPanelDisplayPage.render({ standing: buildUnratedRatingPanelView() })

    expect(ratingPanelDisplayPage.getRating()).toHaveTextContent('Unrated')
    expect(ratingPanelDisplayPage.queryStat('Rank')).toBeNull()
    expect(ratingPanelDisplayPage.queryStat('Peak')).toBeNull()
    expect(ratingPanelDisplayPage.queryDelta()).not.toBeInTheDocument()
  })

  it('still shows an unrated player’s form — form counts decided matches, rated or not', () => {
    ratingPanelDisplayPage.render({
      standing: buildUnratedRatingPanelView({
        form: buildFormChipsView({ results: ['W', 'L'] }),
      }),
    })

    expect(ratingPanelDisplayPage.getChips()).toHaveLength(2)
  })

  it('omits the form entirely for a player with no decided matches', () => {
    ratingPanelDisplayPage.render({
      standing: buildRatingPanelView({ form: null }),
    })

    expect(ratingPanelDisplayPage.queryForm()).not.toBeInTheDocument()
  })
})
