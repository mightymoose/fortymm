import { groupCardPage } from './group-card.page'

describe('GroupCard', () => {
  it('names the group, sizes it, and says how many advance', () => {
    groupCardPage.render({ letter: 'A', size: 8, qualifiers: 2 })

    const card = groupCardPage.getCard()
    expect(card).toHaveTextContent('Group A')
    expect(card).toHaveTextContent('8')
    expect(card).toHaveTextContent('players')
    expect(card).toHaveTextContent('top 2 advance')
  })

  it('reads as playable when the group can supply its qualifiers', () => {
    groupCardPage.render({ size: 8, qualifiers: 2 })

    expect(groupCardPage.queryTooSmall()).toBeNull()
  })

  // A group of one has nobody to play. The derivation calls the whole draw impossible for
  // it; the card says which group.
  it('says "Too small" when the group holds fewer than two players', () => {
    groupCardPage.render({ letter: 'C', size: 1, qualifiers: 1 })

    expect(groupCardPage.queryTooSmall()).toBeInTheDocument()
  })

  // The second, independent condition: the group is playable but cannot send four players
  // to a knockout when only three are in it.
  it('says "Too small" when the group holds fewer players than it must advance', () => {
    groupCardPage.render({ letter: 'C', size: 3, qualifiers: 4 })

    expect(groupCardPage.queryTooSmall()).toBeInTheDocument()
  })

  // The boundary the two conditions meet at: a group of two taking two is legal.
  it('leaves a group that advances every player alone', () => {
    groupCardPage.render({ size: 2, qualifiers: 2 })

    expect(groupCardPage.queryTooSmall()).toBeNull()
  })

  // Green is the advancing state, and a group that cannot advance anybody must not wear
  // it — the tint is the second signal, never the only one.
  it('drops the advancing colour from a group that is too small', () => {
    groupCardPage.render({ size: 1, qualifiers: 1 })

    expect(groupCardPage.getAdvanceLine()).not.toHaveClass(
      'text-[color:var(--serve-500)]',
    )
  })

  it('keeps the advancing colour on a group that can supply its qualifiers', () => {
    groupCardPage.render({ size: 8, qualifiers: 2 })

    expect(groupCardPage.getAdvanceLine()).toHaveClass(
      'text-[color:var(--serve-500)]',
    )
  })
})
