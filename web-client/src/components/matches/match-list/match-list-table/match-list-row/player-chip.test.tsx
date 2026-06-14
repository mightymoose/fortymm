import { buildPlayerChipView } from './player-chip.factory'
import { playerChipPage } from './player-chip.page'

describe('PlayerChip', () => {
  it('renders the side label as the player name', () => {
    playerChipPage.render({
      chip: buildPlayerChipView({ name: 'nguyen.t' }),
    })

    expect(playerChipPage.getPlayerName('nguyen.t')).toHaveTextContent(
      'nguyen.t',
    )
  })

  it('applies is-winner to the name when the chip won', () => {
    playerChipPage.render({
      chip: buildPlayerChipView({ name: 'silva.r', isWinner: true }),
    })

    const name = playerChipPage.getPlayerName('silva.r')
    expect(name).toHaveClass('is-winner')
    expect(name).not.toHaveClass('is-empty')
  })

  it('renders the ghost dashed avatar and an italic is-empty name for an empty side', () => {
    playerChipPage.render({
      chip: buildPlayerChipView({ name: 'No opponent', isEmpty: true }),
    })

    expect(playerChipPage.queryGhostAvatar()).toBeInTheDocument()
    expect(playerChipPage.queryRenderedAvatar('No opponent')).toBeNull()
    expect(playerChipPage.getPlayerName('No opponent')).toHaveClass('is-empty')
  })

  it('renders a UserAvatar (not the ghost) for a present side', () => {
    playerChipPage.render({
      chip: buildPlayerChipView({ name: 'rita.kovac', isEmpty: false }),
    })

    expect(playerChipPage.getRenderedAvatar('rita.kovac')).toBeInTheDocument()
    expect(playerChipPage.queryGhostAvatar()).toBeNull()
  })
})
