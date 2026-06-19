import { emptyCardPage } from './empty-card.page'

describe('EmptyCard', () => {
  it('renders the overline label', () => {
    emptyCardPage.render({ overline: 'Current rating' })

    expect(emptyCardPage.getOverline('Current rating')).toBeInTheDocument()
  })

  it('renders the muted body line', () => {
    emptyCardPage.render({ body: 'Not in a rated league yet.' })

    expect(
      emptyCardPage.getBody('Not in a rated league yet.'),
    ).toBeInTheDocument()
  })
})
