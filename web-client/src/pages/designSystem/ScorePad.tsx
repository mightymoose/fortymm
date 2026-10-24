import { useState, type CSSProperties } from 'react'
import { useAnnounce } from '../../components/announceContext'
import { Button } from '../../components/Button'
import { Icon } from '../../components/Icon'
import { ScrollArea } from '../../components/ScrollArea'
import { useToast } from '../../components/toastContext'
import { GameScores } from './GameScores'
import { addPoint, otherSide, shortName, type MatchPlayer, type Score, type Side } from './match'

// Score entry for the table side, as kit.js's FM.scorepad runs it, styled
// by `.fm-scorepad` in styles/kit.css: each side's name, server, games won
// and points, with a large "+1" target. Each point flashes the number it
// changed and is read out. A won game raises a toast whose Undo takes the
// winning point back, and the "+1" targets turn off once a side has won
// the match. "Undo last point" steps back one point at a time. The game
// history underneath follows the score. `start` is the score it opens on,
// in a match of `bestOf` games.
export function ScorePad({
  players,
  start,
  bestOf,
  style,
}: {
  players: readonly [MatchPlayer, MatchPlayer]
  start: Score
  bestOf: number
  style?: CSSProperties
}) {
  const showToast = useToast()
  const announce = useAnnounce()
  // The side that won each point since the start, in order.
  const [rallies, setRallies] = useState<readonly Side[]>([])
  // How many points each side has won, so its number flashes again on each.
  const [flashes, setFlashes] = useState<readonly [number, number]>([0, 0])
  const score = rallies.reduce(addPoint, start)
  const name = (side: Side) => shortName(players[side])
  const gamesWon = (side: Side) =>
    score.games.filter((game) => game[side] > game[otherSide(side)]).length
  const over = Math.max(gamesWon(0), gamesWon(1)) >= Math.ceil(bestOf / 2)

  function add(side: Side) {
    const next = [...rallies, side]
    const after = addPoint(score, side)
    setRallies(next)
    setFlashes(([first, second]) => (side === 0 ? [first + 1, second] : [first, second + 1]))
    if (after.games.length > score.games.length) {
      const game = after.games[after.games.length - 1]
      showToast(
        `Game ${after.games.length} to ${name(side)}, ${Math.max(...game)}–${Math.min(...game)}`,
        {
          // Only while the winning point is still the last one, so Undo
          // never takes back a point it didn't add.
          undo: () =>
            setRallies((now) => (now.length === next.length ? now.slice(0, -1) : now)),
        },
      )
      return
    }
    const across = otherSide(side)
    announce(`${name(side)} ${after.points[side]}, ${name(across)} ${after.points[across]}`)
  }

  function undoLastPoint() {
    setRallies(rallies.slice(0, -1))
    announce('Last point undone')
  }

  return (
    <div className="fm-scorepad" style={style}>
      {([0, 1] as const).map((side) => (
        <div key={side} className="fm-scorepad__side">
          <div className="fm-scorepad__name">
            <span>{players[side].name}</span>
            <span
              className="serve-marker"
              role="img"
              aria-label="Serving"
              style={{ visibility: score.serve === side ? 'visible' : 'hidden' }}
            ></span>
          </div>
          <div className="fm-scorepad__games">
            Games <b>{gamesWon(side)}</b>
          </div>
          {/* A new key restarts the flash on each point. */}
          <div
            key={flashes[side]}
            className={flashes[side] ? 'fm-scorepad__pts score-updated' : 'fm-scorepad__pts'}
            aria-label={`${name(side)} points`}
          >
            {score.points[side]}
          </div>
          <Button
            variant="primary"
            size="xl"
            className="fm-btn--block"
            disabled={over}
            onClick={() => add(side)}
          >
            +1 {name(side)}
          </Button>
        </div>
      ))}
      <div className="fm-scorepad__bar">
        <Button variant="secondary" disabled={!rallies.length} onClick={undoLastPoint}>
          <Icon name="undo" />
          Undo last point
        </Button>
        <span className="fm-help">Game {start.games.length + 1} · first to 11, win by 2</span>
      </div>
      <ScrollArea style={{ gridColumn: '1/-1', paddingTop: 8 }}>
        {/* Once the match is over, the last game still reads "now", as
            kit.js draws it. */}
        <GameScores
          match={{
            state: 'live',
            players,
            games: over ? score.games : [...score.games, score.points],
          }}
        />
      </ScrollArea>
    </div>
  )
}
