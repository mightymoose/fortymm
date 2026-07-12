import { deltaPillPage } from './delta-pill.page'

describe('DeltaPill', () => {
  it('signs a gain and paints it in the win tone', () => {
    deltaPillPage.render({ delta: 24 })

    const pill = deltaPillPage.getDeltaPill('+24 last match')
    expect(pill).toBeInTheDocument()
    expect(pill).toHaveStyle({ color: 'var(--serve-500)' })
  })

  it('signs a loss and paints it in the loss tone', () => {
    deltaPillPage.render({ delta: -12 })

    const pill = deltaPillPage.getDeltaPill('-12 last match')
    expect(pill).toBeInTheDocument()
    expect(pill).toHaveStyle({ color: 'var(--loss)' })
  })

  it('rounds the move to whole rating points', () => {
    deltaPillPage.render({ delta: 11.6 })

    expect(deltaPillPage.getDeltaPill('+12 last match')).toBeInTheDocument()
  })

  // A rated match CAN move a rating by nothing; that is a fact about a match,
  // and `formatRatingDelta` prints it unsigned ("0", not "+0"). It is win-toned
  // rather than red because nothing was lost. And it is a different statement
  // from "there is no move to report", which renders no chip at all — see the
  // RatingCard's established-rating test.
  it('reads a zero move as an unsigned "0", win-toned — never as a loss', () => {
    deltaPillPage.render({ delta: 0 })

    const pill = deltaPillPage.getDeltaPill('0 last match')
    expect(pill).toBeInTheDocument()
    expect(pill).toHaveStyle({ color: 'var(--serve-500)' })
  })
})
