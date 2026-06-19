import { cardPage } from './card.page'

describe('Card', () => {
  it('renders its children as body content', () => {
    cardPage.render({ children: 'Rating summary' })

    expect(cardPage.getBody('Rating summary')).toHaveTextContent(
      'Rating summary',
    )
  })

  it('lays out as a block so callers control their inner layout', () => {
    cardPage.render({ children: 'body' })

    expect(cardPage.getBody('body')).toHaveStyle({ display: 'block' })
  })

  it('is positioned relatively to anchor absolutely-placed children', () => {
    cardPage.render({ children: 'body' })

    expect(cardPage.getBody('body')).toHaveStyle({ position: 'relative' })
  })

  it('defaults to 20px of padding', () => {
    cardPage.render({ children: 'body' })

    expect(cardPage.getBody('body')).toHaveStyle({ padding: '20px' })
  })

  it('honors an explicit padding override', () => {
    cardPage.render({ children: 'body', padding: 8 })

    expect(cardPage.getBody('body')).toHaveStyle({ padding: '8px' })
  })

  it('merges caller style over the base block layout', () => {
    cardPage.render({ children: 'body', style: { display: 'flex' } })

    expect(cardPage.getBody('body')).toHaveStyle({ display: 'flex' })
  })

  it('forwards arbitrary div props to the surface element', () => {
    cardPage.render({ children: 'body', id: 'rating-card-surface' })

    expect(cardPage.getBody('body')).toHaveAttribute('id', 'rating-card-surface')
  })
})
