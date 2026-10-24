import { matchScore, shortName, type Scoresheet, type Side } from './match'

// A match's game history as match.js's `games()` draws it: an `.fm-games`
// table with a column per game, the game in play marked "now".
export function GameScores({ match }: { match: Scoresheet }) {
  const { done, current } = matchScore(match)
  const games = current ? [...done, current] : done
  if (!games.length) return <p className="fm-help">No games played yet.</p>
  const isCurrent = (index: number) => current !== null && index === games.length - 1
  const [first, second] = match.players

  return (
    <table className="fm-games">
      <caption className="fm-sr">
        Game scores, {first.name} vs {second.name}
      </caption>
      <thead>
        <tr>
          <th scope="col">
            <span className="fm-sr">Player</span>
          </th>
          {games.map((_, index) => (
            <th key={index} scope="col" className={isCurrent(index) ? 'cur' : undefined}>
              {isCurrent(index) ? `Game ${index + 1} · now` : `Game ${index + 1}`}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {([0, 1] as const).map((side: Side) => (
          <tr key={side}>
            <th scope="row">{shortName(match.players[side])}</th>
            {games.map((game, index) => {
              const won = game[side] > game[side === 0 ? 1 : 0]
              const cell = isCurrent(index) ? 'cur' : won ? 'w' : undefined
              return (
                <td key={index} className={cell}>
                  {game[side]}
                </td>
              )
            })}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
