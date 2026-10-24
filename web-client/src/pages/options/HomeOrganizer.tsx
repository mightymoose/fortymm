import { useState } from 'react'
import { Button } from '../../components/Button'
import { Card } from '../../components/Card'
import { DetailList } from '../../components/DetailList'
import { Icon } from '../../components/Icon'
import { Meter } from '../../components/Meter'
import { DemoButton } from '../designSystem/DemoButton'
import { day, findMatch, type ConflictMatch, type Match } from '../designSystem/match'
import { MatchRow } from '../designSystem/MatchRow'
import { Timeline } from '../designSystem/Timeline'

const conflict = (findMatch('b3') as ConflictMatch).conflict

const played = { done: 23, total: 63 }

// The decision on Patel's rest: still open, or what the organizer chose.
type Choice = 'open' | 'moved' | 'kept'

function Decision() {
  const [decision, setDecision] = useState<Choice>('open')
  const undo = (
    <Button variant="link" onClick={() => setDecision('open')}>
      Undo
    </Button>
  )
  switch (decision) {
    case 'open':
      return (
        <div className="fm-alert fm-alert--warning">
          <Icon name="alert" />
          <p className="fm-alert__title">{conflict.title}</p>
          <p className="fm-alert__body">{conflict.body}</p>
          <div className="fm-alert__actions">
            <Button variant="primary" size="sm" onClick={() => setDecision('moved')}>
              {conflict.fix}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setDecision('kept')}>
              Keep 11:50
            </Button>
          </div>
        </div>
      )
    case 'moved':
      return (
        <p className="fm-notice fm-notice--success">
          <Icon name="check" />
          <span>
            Moved Patel vs Park to <span className="num">12:05</span>. Patel gets 15
            minutes’ rest. {undo}
          </span>
        </p>
      )
    case 'kept':
      return (
        <p className="fm-notice fm-notice--warning">
          <Icon name="alert" />
          <span>
            {conflict.kept} {undo}
          </span>
        </p>
      )
  }
}

// Home for the person running today's tournament, in the README's order:
// expected finish against plan, the decision to make, table status, the
// schedule, then the scheduling details folded away.
export function HomeOrganizer() {
  const [selected, setSelected] = useState<Match>(findMatch('a2'))
  return (
    <>
      <header className="opt-page-head">
        <div>
          <h1>Riverside Open</h1>
          <p className="opt-lead">Today · 4 tables · now 11:47</p>
        </div>
      </header>
      <div className="opt-stack-lg">
        <section className="opt-stack" aria-labelledby="opt-finish">
          <h2 className="fm-section-title" id="opt-finish">
            Finish
          </h2>
          <DetailList
            details={[
              { term: 'Expected finish', value: '18:40', numeric: true },
              { term: 'Plan', value: '18:30', numeric: true },
              { term: 'Matches played', value: `${played.done} of ${played.total}` },
            ]}
          />
          <Meter label="Matches played" value={played.done} max={played.total} />
          <p className="fm-notice">
            <Icon name="clock" />
            <span>
              10 minutes behind plan. Patel’s match on Table 3 went to a fifth game.
            </span>
          </p>
        </section>
        <section className="opt-stack" aria-labelledby="opt-decide">
          <h2 className="fm-section-title" id="opt-decide">
            Needs a decision
          </h2>
          <Decision />
        </section>
        <section className="opt-stack" aria-labelledby="opt-tables">
          <h2 className="fm-section-title" id="opt-tables">
            Tables
          </h2>
          <div className="opt-tables">
            <Card title="Table 1">
              <div className="fm-matches">
                <MatchRow match={findMatch('a2')} columns={false} />
              </div>
            </Card>
            <Card
              title="Table 2"
              status={<span className="fm-status">Free</span>}
              actions={<DemoButton variant="secondary" size="sm">Call to table</DemoButton>}
            >
              <p className="body opt-flat">
                Next: Patel vs Park at <span className="num">11:50</span>.
              </p>
              <p className="fm-notice">
                <Icon name="user" />
                <span>Park is ready. Patel is playing on Table 3.</span>
              </p>
            </Card>
            <Card title="Table 3">
              <div className="fm-matches">
                <MatchRow match={findMatch('c2')} columns={false} />
              </div>
            </Card>
            <Card title="Table 4">
              <div className="fm-matches">
                <MatchRow match={findMatch('d1')} columns={false} />
              </div>
            </Card>
          </div>
        </section>
        <section className="opt-stack" aria-labelledby="opt-schedule">
          <h2 className="fm-section-title" id="opt-schedule">
            Schedule
          </h2>
          <div className="fm-scroll opt-timeline">
            <Timeline day={day} initial="a2" onSelect={setSelected} />
          </div>
          <div className="fm-matches opt-selected">
            <MatchRow match={selected} gameScores />
          </div>
        </section>
        <details className="fm-disclosure">
          <summary>Scheduling details</summary>
          <p>
            63 matches over 4 tables, with at least 15 minutes’ rest between a player’s
            matches. The last schedule took 1.4 seconds to make.
          </p>
        </details>
      </div>
    </>
  )
}
