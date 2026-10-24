import { Link } from '@tanstack/react-router'
import { useId } from 'react'
import '../../styles/options.css'
import { options, type OptionKind } from './catalog'

const groups: readonly { kind: OptionKind; title: string; lead: string }[] = [
  {
    kind: 'home',
    title: 'Home',
    lead: 'Today Home is a display heading and a slogan the design system lists as a Don’t. Each option is a full page.',
  },
  {
    kind: 'loading',
    title: 'Loading screen',
    lead: 'Today a ball bounces forever. Each option keeps the timing: shown after 300ms, up for at least 900ms, then a fade-out.',
  },
]

function Group({ kind, title, lead }: (typeof groups)[number]) {
  const headingId = useId()
  return (
    <section className="opt-group" aria-labelledby={headingId}>
      <h2 id={headingId} className="opt-group__title">
        {title}
      </h2>
      <p className="opt-group__lead">{lead}</p>
      <ul className="fm-list fm-list--divided opt-index">
        {options
          .filter((option) => option.kind === kind)
          .map((option) => (
            <li key={option.slug}>
              <div className="opt-index__head">
                <Link to="/options/$option" params={{ option: option.slug }}>
                  {option.title}
                </Link>
                {'recommended' in option && <span className="fm-tag">Recommended</span>}
              </div>
              <p>{option.pitch}</p>
            </li>
          ))}
      </ul>
    </section>
  )
}

// The list of option previews, with a pitch for each and the one the code
// would ship with marked.
export function OptionsIndex() {
  return (
    <>
      <header className="doc-head">
        <h1>Options</h1>
        <p>
          Throwaway previews of a new Home and a new loading screen. Open each
          one, compare them, then pick a direction. Nothing here is sent
          anywhere.
        </p>
      </header>
      {groups.map((group) => (
        <Group key={group.kind} {...group} />
      ))}
    </>
  )
}
