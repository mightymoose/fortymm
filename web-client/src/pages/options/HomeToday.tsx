import { useState } from 'react'
import { Card } from '../../components/Card'
import { DetailList } from '../../components/DetailList'
import { EmptyState } from '../../components/EmptyState'
import { Icon } from '../../components/Icon'
import { Meter } from '../../components/Meter'
import { RatingChange } from '../../components/RatingChange'
import { RestIndicator } from '../../components/RestIndicator'
import { SegmentedControl } from '../../components/SegmentedControl'
import { DemoButton } from '../designSystem/DemoButton'
import { findMatch, type FinalMatch } from '../designSystem/match'
import { MatchRow } from '../designSystem/MatchRow'

// Chen's Round of 32 match, earlier today.
const roundOf32: FinalMatch = {
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
}

const earlier = [
  { when: 'Tue 20 Oct', opponent: 'Moreau, Élodie', score: '1–3', change: -8 },
  { when: 'Tue 20 Oct', opponent: 'Haddad, Youssef', score: '3–0', change: 6 },
]

// The rest the next-match card counts down, at the sample day's 11:47.
const rest = { until: '11:50', length: 15, left: 3 }

function AtTournament() {
  return (
    <div className="opt-split">
      <div className="opt-stack opt-stack--md">
        <Card
          title="Your next match"
          subtitle="Open singles · Round of 16"
          status={
            <span className="fm-status">
              <Icon name="clock" />
              <span className="num">12:00</span>
            </span>
          }
          actions={
            <>
              <DemoButton variant="primary">I’m at the table</DemoButton>
              <DemoButton variant="ghost">Show the draw</DemoButton>
            </>
          }
        >
          <DetailList
            details={[
              { term: 'Opponent', value: 'Ali, Rashid' },
              { term: 'Table', value: 'Table 1' },
            ]}
          />
          <div className="fm-field">
            <div className="opt-row-between">
              <RestIndicator until={rest.until} />
              <span className="fm-help num">{rest.left} min left</span>
            </div>
            <Meter
              label="Rest elapsed"
              value={rest.length - rest.left}
              max={rest.length}
              percent={Math.round(((rest.length - rest.left) / rest.length) * 100)}
              rest
            />
          </div>
          <p className="fm-notice">
            <Icon name="info" />
            <span>We’ll call you when Table 1 is free. The match on it now is in game 4.</span>
          </p>
        </Card>
        <section aria-labelledby="opt-before-you">
          <h2 className="fm-section-title" id="opt-before-you">
            On Table 1 now
          </h2>
          <div className="fm-matches">
            <MatchRow match={findMatch('a2')} />
          </div>
        </section>
      </div>
      <section className="opt-stack" aria-labelledby="opt-results">
        <h2 className="fm-section-title" id="opt-results">
          Your results
        </h2>
        <div className="fm-matches">
          <MatchRow match={roundOf32} gameScores />
        </div>
        <p className="fm-help">
          Rating <RatingChange change={12} />
        </p>
        <h3 className="fm-section-title">Earlier</h3>
        <div className="fm-scroll">
          <table className="fm-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Opponent</th>
                <th className="n">Games</th>
                <th className="n">Rating</th>
              </tr>
            </thead>
            <tbody>
              {earlier.map((result) => (
                <tr key={`${result.when}-${result.opponent}`}>
                  <td>{result.when}</td>
                  <td>{result.opponent}</td>
                  <td className="n">{result.score}</td>
                  <td className="n opt-nowrap">
                    <RatingChange change={result.change} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="fm-help">
          Your rating is <span className="num">1,901</span>.
        </p>
      </section>
    </div>
  )
}

function NoTournament() {
  return (
    <div className="opt-split">
      <EmptyState
        title="No tournament today"
        action={
          <DemoButton variant="primary" size="sm">
            Join with a code
          </DemoButton>
        }
      >
        When you join one, your next match, table and rest show here.
      </EmptyState>
      <EmptyState
        title="No matches yet"
        action={
          <DemoButton variant="secondary" size="sm">
            Log a match
          </DemoButton>
        }
      >
        Log one after you play. Your results and rating show here.
      </EmptyState>
    </div>
  )
}

// Home for a signed-in player at a tournament: the next match, its table
// and rest first, then results with rating changes. A segmented control
// shows the same page for a guest with no tournament.
export function HomeToday() {
  const [view, setView] = useState('At a tournament')
  const atTournament = view === 'At a tournament'
  return (
    <>
      <header className="opt-page-head">
        <div>
          <h1>{atTournament ? 'Today at Riverside Open' : 'Today'}</h1>
          <p className="opt-lead">
            {atTournament ? 'Saturday 24 October · Chen, Wei' : 'Saturday 24 October'}
          </p>
        </div>
        <SegmentedControl
          label="Preview as"
          options={['At a tournament', 'New guest']}
          onChange={setView}
        />
      </header>
      {atTournament ? <AtTournament /> : <NoTournament />}
    </>
  )
}
