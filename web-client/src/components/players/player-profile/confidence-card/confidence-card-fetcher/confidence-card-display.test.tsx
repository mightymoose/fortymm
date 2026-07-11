import { screen } from '@/test/utilities'

import { confidenceCardDisplayPage } from './confidence-card-display.page'
import {
  buildFirmingUpConfidenceView,
  buildProvisionalConfidenceView,
} from './confidence-card-display.factory'

describe('ConfidenceCardDisplay', () => {
  it('names the level in words and puts the 95% interval on the card’s face', async () => {
    confidenceCardDisplayPage.render()

    expect(confidenceCardDisplayPage.getConfidenceLevel()).toHaveTextContent(
      'Settled',
    )
    // The interval is the honest, concrete version of the claim — it belongs in
    // front of the reader, not in the drawer.
    expect(confidenceCardDisplayPage.getConfidenceInterval()).toHaveTextContent(
      'We think they’re somewhere between 1551 and 1823.',
    )
    expect(
      confidenceCardDisplayPage.getConfidenceInterval().closest('details'),
    ).toBeNull()
  })

  it('says "Firming up", not the wire’s "firming_up"', () => {
    confidenceCardDisplayPage.render({
      confidence: buildFirmingUpConfidenceView(),
    })

    expect(confidenceCardDisplayPage.getConfidenceLevel()).toHaveTextContent(
      'Firming up',
    )
    expect(
      confidenceCardDisplayPage.getConfidenceCard(),
    ).not.toHaveTextContent('firming_up')
  })

  it('addresses a STRANGER in the third person — never "you"', () => {
    // The default: you are looking at somebody else's profile.
    confidenceCardDisplayPage.render({ isViewer: false })

    expect(
      confidenceCardDisplayPage.getConfidenceExplanation(),
    ).toHaveTextContent('A reliable read on where they stand. The math is quiet.')
    // Nothing anywhere on this card may address the player as "you" — not the
    // explanation, and not the interval sentence either.
    expect(confidenceCardDisplayPage.getConfidenceCard().textContent).not.toMatch(
      /\byou\b|you’re/i,
    )
  })

  it('addresses the VIEWER in the second person on their own profile', () => {
    confidenceCardDisplayPage.render({ isViewer: true })

    expect(
      confidenceCardDisplayPage.getConfidenceExplanation(),
    ).toHaveTextContent('A reliable read on where you stand. The math is quiet.')
    expect(confidenceCardDisplayPage.getConfidenceInterval()).toHaveTextContent(
      'We think you’re somewhere between 1551 and 1823.',
    )
    // …and the third-person voice is gone, not merely joined.
    expect(confidenceCardDisplayPage.getConfidenceCard().textContent).not.toMatch(
      /\bthey\b|they’re/i,
    )
  })

  it('keeps the distinction between where you STAND and where you BELONG', () => {
    // Provisional is not "settled, but hedged": we do not know where this player
    // belongs at all. A copy template that swapped only the pronoun would flatten
    // that.
    confidenceCardDisplayPage.render({
      confidence: buildProvisionalConfidenceView(),
      isViewer: true,
    })

    expect(
      confidenceCardDisplayPage.getConfidenceExplanation(),
    ).toHaveTextContent('We’re still working out where you belong. Expect big swings.')
    // And the interval is honestly enormous, which is the point of saying so.
    expect(confidenceCardDisplayPage.getConfidenceInterval()).toHaveTextContent(
      'between 1088 and 1912',
    )
  })

  it('keeps deviation and volatility in a CLOSED drawer, off the face', () => {
    confidenceCardDisplayPage.render()

    const drawer = confidenceCardDisplayPage.getConfidenceDrawer()
    // Collapsed: nobody opening a profile is asking after a rating deviation.
    expect(drawer).not.toHaveAttribute('open')

    const deviation = confidenceCardDisplayPage.queryConfidenceDetail(
      'Deviation (RD)',
    )
    const volatility = confidenceCardDisplayPage.queryConfidenceDetail(
      'Volatility (σ)',
    )
    expect(deviation).toHaveTextContent('69.4')
    expect(volatility).toHaveTextContent('0.0592')
    // …and they are INSIDE the drawer — RD and σ are the internals behind
    // confidence, not names for it, so they must not be on the card's face.
    expect(deviation!.closest('details')).toBe(drawer)
    expect(volatility!.closest('details')).toBe(drawer)
  })

  it('shows NO confidence percentage — no percent, no bar, no 0–100 anything', () => {
    // An earlier design had an "86%" bar. It was deliberately cut: it is an
    // arbitrary rescaling of RD onto a 0–100 axis that says nothing the level and
    // the interval don't say better. This test exists to stop it coming back.
    confidenceCardDisplayPage.render()

    expect(confidenceCardDisplayPage.getConfidenceCard().textContent).not.toContain(
      '%',
    )
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    expect(screen.queryByRole('meter')).not.toBeInTheDocument()
  })
})
