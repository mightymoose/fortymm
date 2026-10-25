import { Link } from '@tanstack/react-router'
import { Icon } from '../../components/Icon'
import { answered, type Adoption } from './adoption'
import { scenarioIds, scenarios, type ScenarioId } from './scenarios'
import './adopt.css'

export function AnsweredNotices({ done }: { done: Adoption['done'] }) {
  return done.map(({ question, answer }) => (
    <p key={question.playerId} className="fm-notice fm-notice--success" role="status">
      <Icon name="check" />
      <span>{answered(answer, question.displayName)}</span>
    </p>
  ))
}

const options = ['/adopt1', '/adopt2', '/adopt3'] as const

// Links between the mockups and their states, so reviewers can compare them.
export function MockupBar({ state }: { state: ScenarioId }) {
  return (
    <div className="adopt-bar">
      <nav aria-label="Mockups">
        <span>Mockup</span>
        {options.map((to, index) => (
          <Link key={to} to={to} search={{ state }}>
            Option {index + 1}
          </Link>
        ))}
      </nav>
      <nav aria-label="States">
        <span>State</span>
        {scenarioIds.map((id) => (
          <Link key={id} to="." search={{ state: id }}>
            {scenarios[id].label}
          </Link>
        ))}
      </nav>
    </div>
  )
}
