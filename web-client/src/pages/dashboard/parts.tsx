import { Link } from '@tanstack/react-router'
import { Icon } from '../../components/Icon'
import type { Outcome, RecentMatch } from './dashboard'

export function NewMatchLink({ size, variant = 'primary' }: { size?: 'sm' | 'lg'; variant?: 'primary' | 'secondary' }) {
  return (
    <Link to="/matches/new" className={`fm-btn fm-btn--${variant}${size ? ` fm-btn--${size}` : ''}`}>
      <Icon name="plus" />
      New match
    </Link>
  )
}

// "Won 3–1", with the score in mono. A match with no result yet says so.
export function ResultText({ match }: { match: RecentMatch }) {
  if (!match.result) return <span className="dash-result dash-result--none">No result yet</span>
  const { won, games } = match.result
  return (
    <span className={`dash-result dash-result--${won ? 'won' : 'lost'}`}>
      {won ? 'Won' : 'Lost'}{' '}
      <span className="num">
        {games[0]}–{games[1]}
      </span>
    </span>
  )
}

// The last results, oldest on the left so it reads like a scoreboard, as
// boxed W and L. A win is bold in a filled box, a loss steps down, like the
// games tally of a match row.
export function FormStrip({ form }: { form: readonly Outcome[] }) {
  const oldestFirst = [...form].reverse()
  return (
    <ol className="dash-form" aria-label={`Last ${form.length} results, oldest first`}>
      {oldestFirst.map((outcome, index) => (
        <li key={index} className={`dash-form__box dash-form__box--${outcome}`}>
          <span aria-hidden="true">{outcome === 'won' ? 'W' : 'L'}</span>
          <span className="fm-sr">{outcome === 'won' ? 'Won' : 'Lost'}</span>
        </li>
      ))}
    </ol>
  )
}

export function Skeleton({ width, height = 16 }: { width: number | string; height?: number }) {
  return <span className="fm-skeleton dash-skel" style={{ width, height }} />
}
