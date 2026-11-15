import { Link } from '@tanstack/react-router'
import { ButtonLink } from '../ButtonLink.tsx'
import { EmptyState } from '../EmptyState.tsx'
import { Icon } from '../Icon.tsx'
import './MatchListScreen.css'

// One match as the list shows it.
export type ListedMatch = {
  id: string
  opponent: string
  bestOf: 1 | 3 | 5 | 7
  rated: boolean
  // When it started: the list's order, newest first.
  startedAt: Date
  // The games each side has won so far.
  games: { you: number; them: number }
  // Whether either side has won the match.
  finished: boolean
}

export type MatchListScreenProps = {
  // In any order: the screen shows them newest first.
  matches: readonly ListedMatch[]
  // The address of a match's own page, by its id. A plain path until the
  // match's route (/matches/$matchId) exists; then the router's typed
  // `to` and `params` replace it.
  matchLink: (id: string) => string
}

// The matches list, at /matches: a person's matches, newest first. Its
// heading with, at non-phone widths, the "New match" button beside it (as on
// the dashboard; on a phone the bottom bar's is the way there). Each match is
// a row of a table: the opponent, a link to the match's page, the format
// (best of n, rated or not), its state (in progress and the next game, or
// finished and who won) and the score in games. On phones each row is drawn
// as a card (AppLayout.css's breakpoint, read in MatchListScreen.css); it is
// the same table. With no matches, the design system's empty state, with
// its own New match. It renders in the layout's <main> (AppLayout).
export function MatchListScreen({ matches, matchLink }: MatchListScreenProps) {
  const newestFirst = [...matches].sort(
    (a, b) => b.startedAt.getTime() - a.startedAt.getTime(),
  )
  return (
    <>
      <div className="match-list-screen__head">
        <h1>Matches</h1>
        {matches.length > 0 && (
          <ButtonLink
            to="/matches/new"
            variant="primary"
            className="match-list-screen__new-match"
          >
            <Icon name="plus" />
            New match
          </ButtonLink>
        )}
      </div>
      {matches.length === 0 ? (
        <EmptyState
          title="No matches yet."
          action={
            <ButtonLink to="/matches/new" variant="primary">
              <Icon name="plus" />
              New match
            </ButtonLink>
          }
        >
          Start a match and it shows here, with its score.
        </EmptyState>
      ) : (
        <table className="match-list-screen__table" aria-label="Matches">
          <thead>
            <tr>
              <th scope="col">Opponent</th>
              <th scope="col">Format</th>
              <th scope="col">State</th>
              <th scope="col" className="match-list-screen__games">
                Games
              </th>
            </tr>
          </thead>
          <tbody>
            {newestFirst.map((match) => (
              <tr key={match.id}>
                <td className="match-list-screen__opponent">
                  {/* Its box covers the whole row (MatchListScreen.css). */}
                  <Link
                    to={matchLink(match.id)}
                    className="match-list-screen__link"
                  >
                    You vs {match.opponent}
                  </Link>
                </td>
                <td className="match-list-screen__format">
                  Best of {match.bestOf} · {match.rated ? 'Rated' : 'Unrated'}
                </td>
                <td className="match-list-screen__state">{state(match)}</td>
                <td className="match-list-screen__games">
                  {match.games.you} – {match.games.them}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}

// "In progress · Game 4 next", or "Finished · You won" ("Ben won").
function state({ games, finished, opponent }: ListedMatch) {
  if (!finished) return `In progress · Game ${games.you + games.them + 1} next`
  return `Finished · ${games.you > games.them ? 'You' : opponent} won`
}
