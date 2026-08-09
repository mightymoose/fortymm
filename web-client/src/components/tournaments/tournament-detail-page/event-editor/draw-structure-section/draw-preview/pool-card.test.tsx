import { poolCardPage } from './pool-card.page'

describe('PoolCard', () => {
  it('names the pool, sizes it, and says how many advance', () => {
    poolCardPage.render({ letter: 'A', size: 8, qualifiers: 2 })

    const card = poolCardPage.getCard()
    expect(card).toHaveTextContent('Pool A')
    expect(card).toHaveTextContent('8')
    expect(card).toHaveTextContent('players')
    expect(card).toHaveTextContent('top 2 advance')
  })

  it('reads as playable when the pool can supply its qualifiers', () => {
    poolCardPage.render({ size: 8, qualifiers: 2 })

    expect(poolCardPage.queryTooSmall()).toBeNull()
  })

  // A pool of one has nobody to play. The derivation calls the whole draw impossible for
  // it; the card says which pool.
  it('says "Too small" when the pool holds fewer than two players', () => {
    poolCardPage.render({ letter: 'C', size: 1, qualifiers: 1 })

    expect(poolCardPage.queryTooSmall()).toBeInTheDocument()
  })

  // The second, independent condition: the pool is playable but cannot send four players
  // to a knockout when only three are in it.
  it('says "Too small" when the pool holds fewer players than it must advance', () => {
    poolCardPage.render({ letter: 'C', size: 3, qualifiers: 4 })

    expect(poolCardPage.queryTooSmall()).toBeInTheDocument()
  })

  // The boundary the two conditions meet at: a pool of two taking two is legal.
  it('leaves a pool that advances every player alone', () => {
    poolCardPage.render({ size: 2, qualifiers: 2 })

    expect(poolCardPage.queryTooSmall()).toBeNull()
  })

  // Green is the advancing state, and a pool that cannot advance anybody must not wear
  // it — the tint is the second signal, never the only one.
  it('drops the advancing colour from a pool that is too small', () => {
    poolCardPage.render({ size: 1, qualifiers: 1 })

    expect(poolCardPage.getAdvanceLine()).not.toHaveClass(
      'text-[color:var(--serve-500)]',
    )
  })

  it('keeps the advancing colour on a pool that can supply its qualifiers', () => {
    poolCardPage.render({ size: 8, qualifiers: 2 })

    expect(poolCardPage.getAdvanceLine()).toHaveClass(
      'text-[color:var(--serve-500)]',
    )
  })
})
