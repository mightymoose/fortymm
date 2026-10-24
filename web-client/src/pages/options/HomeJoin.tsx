import { useId, useState, type ReactNode } from 'react'
import { Card } from '../../components/Card'
import { CodeInput } from '../../components/CodeInput'
import { DetailList, type Detail } from '../../components/DetailList'
import { Icon } from '../../components/Icon'
import { DemoButton } from '../designSystem/DemoButton'

type Tournament = {
  name: string
  where: string
  status: ReactNode
  details: readonly Detail[]
}

// The demo's tournaments, by join code.
const tournaments: Record<string, Tournament> = {
  RIV426: {
    name: 'Riverside Open',
    where: 'Today · Riverside TT hall',
    status: (
      <span className="fm-status">
        <Icon name="check" />
        Check-in open
      </span>
    ),
    details: [
      { term: 'Starts', value: '10:30', numeric: true },
      { term: 'Checked in', value: '48 of 64' },
      { term: 'Organizer', value: 'Okoye, Sam' },
      { term: 'Events', value: 'Open singles, Under 18 singles, Open doubles' },
    ],
  },
  NSL900: {
    name: 'Northside league night',
    where: 'Tue 27 October · Northside community centre',
    status: (
      <span className="fm-status">
        <Icon name="check" />
        Sign-up open
      </span>
    ),
    details: [
      { term: 'Starts', value: '19:00', numeric: true },
      { term: 'Signed up', value: '14 of 24' },
      { term: 'Organizer', value: 'Lindqvist, Erik' },
      { term: 'Events', value: 'Division 2 singles' },
    ],
  },
}

// Home for someone who just walked into a venue: the join code is the
// page. A full code shows what it finds, from the demo's tournaments.
export function HomeJoin() {
  const labelId = useId()
  const helpId = useId()
  const errorId = useId()
  const [code, setCode] = useState('')
  const complete = code.length === 6
  const found = complete ? tournaments[code] : undefined
  const missing = complete && !found
  return (
    <div className="opt-narrow">
      <header className="opt-stack-sm">
        <h1>Join a tournament</h1>
        <p className="opt-lead">
          Type the 6-character code from the sign at the desk or your organizer’s message.
        </p>
      </header>
      <div className="fm-field opt-code">
        <span className="fm-label" id={labelId}>
          Tournament code
        </span>
        <CodeInput
          aria-labelledby={labelId}
          invalid={missing}
          describedBy={missing ? `${helpId} ${errorId}` : helpId}
          onInput={setCode}
        />
        <p className="fm-help" id={helpId}>
          For this demo, try <span className="num">RIV426</span> or{' '}
          <span className="num">NSL900</span>.
        </p>
        {missing && (
          <p className="fm-error" id={errorId}>
            <Icon name="error" />
            <span>
              No tournament uses <span className="num">{code}</span>. Check the sign, or
              ask at the desk.
            </span>
          </p>
        )}
      </div>
      {found && (
        <Card
          title={found.name}
          subtitle={found.where}
          status={found.status}
          actions={
            <>
              <DemoButton variant="primary">Join as a player</DemoButton>
              <DemoButton variant="ghost">Watch as a spectator</DemoButton>
            </>
          }
        >
          <DetailList details={found.details} />
        </Card>
      )}
      <section className="opt-stack-sm opt-aside" aria-labelledby="opt-no-code">
        <h2 className="fm-section-title" id="opt-no-code">
          No code?
        </h2>
        <p className="body">
          Keep score of a friendly match on your own. You can join a tournament later.
        </p>
        <div>
          <DemoButton variant="secondary">Log a match</DemoButton>
        </div>
      </section>
    </div>
  )
}
