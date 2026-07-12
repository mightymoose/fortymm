import {
  buildCareerTileView,
  buildGamesWonTileView,
} from './career-tile.factory'
import { careerTilePage } from './career-tile.page'

describe('CareerTile', () => {
  it('shows its value under its label', () => {
    careerTilePage.render({
      tile: buildCareerTileView({ label: 'Best streak', value: '7 wins' }),
    })

    expect(careerTilePage.queryCareerTile('Best streak')).toHaveTextContent(
      '7 wins',
    )
  })

  it('prints the games-won share as the percentage it is', () => {
    // 0.582 on the wire is 58.2% on the tile — the projection has already said
    // so, and the tile prints it verbatim rather than reformatting it.
    careerTilePage.render({ tile: buildGamesWonTileView({ value: '58.2%' }) })

    expect(careerTilePage.queryCareerTile('Games won')).toHaveTextContent(
      '58.2%',
    )
  })

  it('prints an em dash — not a zero — where the player has no such number', () => {
    careerTilePage.render({ tile: buildGamesWonTileView({ value: '—' }) })

    const tile = careerTilePage.queryCareerTile('Games won')
    expect(tile).toHaveTextContent('—')
    expect(tile).not.toHaveTextContent('0')
  })
})
