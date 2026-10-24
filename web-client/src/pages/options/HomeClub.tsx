import { useState } from 'react'
import { EmptyState } from '../../components/EmptyState'
import { RatingChange } from '../../components/RatingChange'
import { SegmentedControl } from '../../components/SegmentedControl'
import { DemoButton } from '../designSystem/DemoButton'
import { findMatch, type FinalMatch, type Match } from '../designSystem/match'
import { MatchRow } from '../designSystem/MatchRow'

// Riverside's matches on the tables now, and next up.
const onTables: readonly Match[] = ['c2', 'd1', 'a3'].map(findMatch)

// Riverside's finished matches today.
const results: readonly Match[] = [
  findMatch('a1'),
  findMatch('b1'),
  {
    id: 'x1',
    table: 2,
    state: 'final',
    start: '11:00',
    end: '11:35',
    event: 'Open singles',
    round: 'Round of 32',
    players: [
      { name: 'Chen, Wei', club: 'Riverside TT' },
      { name: 'Lindqvist, Erik', club: 'Northside' },
    ],
    games: [[11, 6], [9, 11], [11, 8], [11, 7]],
  } satisfies FinalMatch,
]

const ladder = [
  { name: 'Nguyen, Thanh', rating: 2145, played: 42, today: 12 },
  { name: 'Chen, Wei', rating: 1901, played: 35, today: 12 },
  { name: 'Patel, Meera', rating: 1840, played: 28, today: 0 },
  { name: 'Haddad, Youssef', rating: 1702, played: 31, today: -9 },
  { name: 'Rossi, Giulia', rating: 1688, played: 19, today: 0 },
]

const thousands = new Intl.NumberFormat('en-US')

function Member() {
  return (
    <div className="opt-stack-lg">
      <section className="opt-stack" aria-labelledby="opt-on-tables">
        <h2 className="fm-section-title" id="opt-on-tables">
          On the tables now
        </h2>
        <div className="opt-live">
          {onTables.map((match) => (
            <div key={match.id} className="fm-card opt-slide">
              <div className="fm-matches">
                <MatchRow match={match} clubs />
              </div>
            </div>
          ))}
        </div>
      </section>
      <div className="opt-split">
        <section className="opt-stack" aria-labelledby="opt-club-results">
          <h2 className="fm-section-title" id="opt-club-results">
            Today’s results
          </h2>
          <div className="fm-matches">
            {results.map((match) => (
              <MatchRow key={match.id} match={match} clubs gameScores />
            ))}
          </div>
        </section>
        <section className="opt-stack" aria-labelledby="opt-ladder">
          <h2 className="fm-section-title" id="opt-ladder">
            Club ladder
          </h2>
          <div className="fm-scroll">
            <table className="fm-table">
              <thead>
                <tr>
                  <th>Player</th>
                  <th className="n">Played</th>
                  <th className="n">Rating</th>
                  <th className="n">Today</th>
                </tr>
              </thead>
              <tbody>
                {ladder.map((player) => (
                  <tr key={player.name}>
                    <td className="opt-strong">{player.name}</td>
                    <td className="n">{player.played}</td>
                    <td className="n">{thousands.format(player.rating)}</td>
                    <td className="n opt-nowrap">
                      <RatingChange change={player.today} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  )
}

// Home for a club member following from home: the club's matches on the
// tables now, today's results and the club ladder. A segmented control
// shows the same page for a guest with no club.
export function HomeClub() {
  const [view, setView] = useState('Club member')
  const member = view === 'Club member'
  return (
    <>
      <header className="opt-page-head">
        <div>
          <h1>{member ? 'Riverside TT' : 'Your club'}</h1>
          <p className="opt-lead">
            {member ? '5 members playing at Riverside Open today' : 'Saturday 24 October'}
          </p>
        </div>
        <SegmentedControl
          label="Preview as"
          options={['Club member', 'New guest']}
          onChange={setView}
        />
      </header>
      {member ? (
        <Member />
      ) : (
        <EmptyState
          title="You’re not in a club yet"
          action={
            <DemoButton variant="primary" size="sm">
              Find your club
            </DemoButton>
          }
        >
          Join one to follow its matches, results and ladder here.
        </EmptyState>
      )}
    </>
  )
}
