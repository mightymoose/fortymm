import {
  buildEmptyWinRateRingView,
  buildWinRateRingView,
} from './win-rate-ring.factory'
import { winRateRingPage } from './win-rate-ring.page'

/** The arc's full length — `2πr`, r = 42. A full sweep leaves no offset; half a
 * sweep leaves half. */
const CIRCUMFERENCE = 2 * Math.PI * 42

describe('WinRateRing', () => {
  it('prints the pre-formatted percentage in the middle', () => {
    winRateRingPage.render({
      ring: buildWinRateRingView({
        share: 0.375,
        label: '37.5%',
        ariaLabel: 'Win rate 37.5%',
      }),
    })

    expect(winRateRingPage.getRingFigure()).toHaveTextContent('37.5%')
    expect(winRateRingPage.getRing()).toHaveAccessibleName('Win rate 37.5%')
  })

  it('sweeps the arc in proportion to the share', () => {
    winRateRingPage.render({
      ring: buildWinRateRingView({ share: 0.5, label: '50%' }),
    })

    const arc = winRateRingPage.queryRingArc()
    // Half the ring drawn: the dash offset is half the circumference.
    expect(Number(arc?.getAttribute('stroke-dashoffset'))).toBeCloseTo(
      CIRCUMFERENCE / 2,
      4,
    )
  })

  it('draws NO arc, and an em dash — not "0%" — when nothing is decided', () => {
    // A share of `null` is not a share of zero: the player hasn't lost every
    // match, they haven't finished any.
    winRateRingPage.render({ ring: buildEmptyWinRateRingView() })

    expect(winRateRingPage.queryRingArc()).toBeNull()
    expect(winRateRingPage.getRingFigure()).toHaveTextContent('—')
    expect(winRateRingPage.getRingFigure()).not.toHaveTextContent('0%')
    expect(winRateRingPage.getRing()).toHaveAccessibleName(
      'Win rate unavailable: no decided matches yet',
    )
  })

  it('draws a real 0% — an empty arc over a "0%" — for a player who lost every decided match', () => {
    winRateRingPage.render({
      ring: buildWinRateRingView({
        share: 0,
        label: '0%',
        ariaLabel: 'Win rate 0%',
      }),
    })

    // The arc exists (this player HAS a rate; it is zero) but sweeps nothing.
    const arc = winRateRingPage.queryRingArc()
    expect(arc).not.toBeNull()
    expect(Number(arc?.getAttribute('stroke-dashoffset'))).toBeCloseTo(
      CIRCUMFERENCE,
      4,
    )
    expect(winRateRingPage.getRingFigure()).toHaveTextContent('0%')
  })
})
