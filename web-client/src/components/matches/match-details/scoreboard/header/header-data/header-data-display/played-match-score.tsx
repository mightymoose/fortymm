import type { GameScore, HeaderSide } from '../header-data-query'
import { MatchScoreSlot } from './match-score-slot'
import { PlayerScore } from '../../../player-score'
import { Participant } from '../../../participant'

export interface PlayedMatchScoreProps {
  sides: HeaderSide[]
  games: GameScore[][]
  bestOf: number
}

export const PlayedMatchScore = ({ sides, games, bestOf }: PlayedMatchScoreProps) => {
  const winnerOf = (game: GameScore[]) =>
    game.reduce((best, side) => (side.points > best.points ? side : best)).sideNumber
  const gamesWonBy = (sideNumber: number) =>
    games.filter((game) => winnerOf(game) === sideNumber).length

  const leftScore = gamesWonBy(0)
  const rightScore = gamesWonBy(1)

  const gamesToWin = Math.floor(bestOf / 2) + 1
  const leftWon = leftScore >= gamesToWin
  const rightWon = rightScore >= gamesToWin

  const [left, right] = sides

  return (
    <div className="md-hero__row" role="group" aria-label="Match score">
      <Participant size="hero" align="l" username={left.username} won={leftWon} />
      <PlayerScore
        className="md-hero__score md-hero__score--l"
        label={`${left.username} sets`}
        score={leftScore}
        won={leftWon}
      />
      <MatchScoreSlot>
        <span className="md-hero__score-dash">—</span>
        <span className="md-hero__score-vs">vs</span>
      </MatchScoreSlot>
      <PlayerScore
        className="md-hero__score md-hero__score--r"
        label={`${right.username} sets`}
        score={rightScore}
        won={rightWon}
      />
      <Participant size="hero" align="r" username={right.username} won={rightWon} />
    </div>
  )
}
