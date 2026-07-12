import {
  buildCareerView,
  buildEmptyCareerView,
} from './career-card-display.factory'
import {
  buildCareerTileView,
  buildGamesWonTileView,
} from './career-card-display/career-tile.factory'
import { buildWinRateRingView } from './career-card-display/win-rate-ring.factory'
import { careerCardDisplayPage } from './career-card-display.page'

describe('CareerCardDisplay', () => {
  it('shows the win-rate ring, the W–L and the current streak', () => {
    careerCardDisplayPage.render({
      career: buildCareerView({
        ring: buildWinRateRingView({
          share: 0.375,
          label: '37.5%',
          ariaLabel: 'Win rate 37.5%',
        }),
        record: '15 W · 25 L',
        streak: { label: 'On a 2-win streak', tone: 'win' },
      }),
    })

    expect(careerCardDisplayPage.getCareerCard()).toBeInTheDocument()
    // 0.375 on the wire is 37.5% on the ring — never "0.375%", never "0%".
    expect(careerCardDisplayPage.getRingFigure()).toHaveTextContent('37.5%')
    expect(careerCardDisplayPage.getCareerRecord()).toHaveTextContent(
      '15 W · 25 L',
    )
    expect(careerCardDisplayPage.getCareerStreak()).toHaveTextContent(
      'On a 2-win streak',
    )
  })

  it('shows the best-streak and games-won tiles', () => {
    careerCardDisplayPage.render({
      career: buildCareerView({
        tiles: [
          buildCareerTileView({ value: '7 wins' }),
          buildGamesWonTileView({ value: '58.2%' }),
        ],
      }),
    })

    expect(careerCardDisplayPage.queryCareerTile('Best streak')).toHaveTextContent(
      '7 wins',
    )
    expect(careerCardDisplayPage.queryCareerTile('Games won')).toHaveTextContent(
      '58.2%',
    )
  })

  it('labels its total as DECIDED matches, so it can’t be read as the history count', () => {
    // The Recent-matches card sitting beside this one links to "View all 50
    // matches" — the all-inclusive history. This card counts the 47 that were
    // decided. Both are right; the word "decided" is what keeps them apart
    // (ADR-0915).
    careerCardDisplayPage.render({
      career: buildCareerView({ total: '47 decided · 2 leagues' }),
    })

    const total = careerCardDisplayPage.getCareerTotal()
    expect(total).toHaveTextContent('47 decided · 2 leagues')
    // …and never "47 matches", which is what the reader would try to square with
    // the "View all 50 matches" link next door.
    expect(total).not.toHaveTextContent('matches')
  })

  it('shows em dashes and no streak — never a "0%" — for a player who has decided nothing', () => {
    careerCardDisplayPage.render({ career: buildEmptyCareerView() })

    expect(careerCardDisplayPage.getRingFigure()).toHaveTextContent('—')
    expect(careerCardDisplayPage.getRingFigure()).not.toHaveTextContent('0%')
    expect(careerCardDisplayPage.queryRingArc()).toBeNull()
    expect(careerCardDisplayPage.queryCareerTile('Games won')).toHaveTextContent(
      '—',
    )
    expect(
      careerCardDisplayPage.queryCareerTile('Best streak'),
    ).toHaveTextContent('—')
    expect(careerCardDisplayPage.getCareerStreak()).toHaveTextContent(
      'No current streak',
    )
  })
})
