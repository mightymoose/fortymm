import { Icon, type IconName } from '../../components/Icon'
import { DemoButton } from '../designSystem/DemoButton'
import { findMatch } from '../designSystem/match'
import { MatchRow } from '../designSystem/MatchRow'

const uses: readonly { icon: IconName; title: string; body: string }[] = [
  {
    icon: 'plus',
    title: 'Keep score at the table',
    body: 'Large +1 buttons for each side, the serve tracked for you, and Undo for the last point.',
  },
  {
    icon: 'calendar',
    title: 'Run a tournament',
    body: 'Draws, tables and the schedule in one place. When a match runs over, FortyMM suggests a fix.',
  },
  {
    icon: 'list',
    title: 'Follow your club',
    body: 'Live scores from every table, results as they finish, and each player’s rating change.',
  },
]

// Home for someone who just opened FortyMM: the hero line, two actions,
// the commitment once, and a live match to show what the app is for.
export function HomeWelcome() {
  return (
    <>
      <div className="opt-hero">
        <div className="opt-hero__text">
          <h1>Keep score, run tournaments and follow your club’s results.</h1>
          <p className="opt-lead">Free. We don’t show ads.</p>
          <div className="opt-actions">
            <DemoButton variant="primary" size="lg">
              Log a match
            </DemoButton>
            <DemoButton variant="secondary" size="lg">
              Join with a code
            </DemoButton>
          </div>
        </div>
        <section className="fm-card" aria-label="Example: live at Riverside Open">
          <div className="fm-card__head">
            <div>
              <h2 className="fm-card__title">Live at Riverside Open</h2>
              <p className="fm-card__sub">Example of a tournament on FortyMM</p>
            </div>
          </div>
          <div className="fm-card__body">
            <div className="fm-matches">
              <MatchRow match={findMatch('c2')} />
              <MatchRow match={findMatch('a1')} />
            </div>
          </div>
        </section>
      </div>
      <ul className="opt-uses">
        {uses.map((use) => (
          <li key={use.title}>
            <Icon name={use.icon} />
            <div>
              <h2 className="fm-section-title">{use.title}</h2>
              <p>{use.body}</p>
            </div>
          </li>
        ))}
      </ul>
    </>
  )
}
