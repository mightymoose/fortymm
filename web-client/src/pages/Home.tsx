import { useSuspenseQuery } from '@tanstack/react-query'
import { Link, useRouteContext, useRouterState, useSearch } from '@tanstack/react-router'
import { useEffect, useRef, type Ref } from 'react'
import { can, Permission } from '../api/permissions'
import { sessionQuery } from '../api/queries'
import { Icon, type IconName } from '../components/Icon'
import { AfterSignIn } from './adoption/AfterSignIn'
import { DashboardOption, OptionSwitcher } from './dashboard/DashboardOptions'
import { useNarrowLayout } from './useNarrowLayout'

type Stage = 'ready' | 'building' | 'next' | 'later'

const stageLabels: Record<Stage, string> = {
  ready: 'Ready',
  building: 'Building now',
  next: 'Next',
  later: 'Later',
}

// The parts of FortyMM, in the order they ship.
const parts: readonly { title: string; body: string; icon: IconName; stage: Stage }[] = [
  {
    title: 'Your account',
    body: 'Sign in on any device. Your matches, leagues and rating stay with your account.',
    icon: 'user',
    stage: 'ready',
  },
  {
    title: 'Leagues',
    body: 'Play a season with your club or your friends, and follow the standings.',
    icon: 'list',
    stage: 'ready',
  },
  {
    title: 'Matches',
    body: 'Log the matches you play and follow your rating after each one.',
    icon: 'table',
    stage: 'building',
  },
  {
    title: 'Basic tournaments',
    body: 'Run a simple tournament with your friends, from the draw to the final.',
    icon: 'calendar',
    stage: 'later',
  },
]

// Below 900px the New match link is in the tab bar instead (AppShell). Back
// from the review, focus goes to the title, so it doesn't fall to the
// document.
export function Home() {
  const title = useRef<HTMLHeadingElement>(null)
  const fromReview = useRouterState({ select: (state) => state.location.state.fromReview })
  const { api } = useRouteContext({ from: '__root__' })
  const { data: account } = useSuspenseQuery(sessionQuery(api))
  const narrow = useNarrowLayout()
  const { signed_in: signedIn, variant, sample } = useSearch({ from: '/_authenticated/_shell/' })

  useEffect(() => {
    if (fromReview) title.current?.focus()
  }, [fromReview])

  return (
    <div className="home">
      {signedIn && <AfterSignIn />}
      <OptionSwitcher variant={variant} sample={sample} />
      {variant ? (
        <DashboardOption variant={variant} sample={sample} />
      ) : (
        <CurrentHome titleRef={title} canCreate={!narrow && can(account, Permission.matchesCreate)} />
      )}
    </div>
  )
}

function CurrentHome({ titleRef, canCreate }: { titleRef: Ref<HTMLHeadingElement>; canCreate: boolean }) {
  return (
    <>
      {canCreate && (
        <div>
          <Link to="/matches/new" className="fm-btn fm-btn--primary">
            <Icon name="plus" />
            New match
          </Link>
        </div>
      )}
      <Roadmap titleRef={titleRef} />
    </>
  )
}

// What we're building and what comes after, styled by `.roadmap` in
// styles/base.css. Each part's stage sets its colour there.
function Roadmap({ titleRef }: { titleRef: Ref<HTMLHeadingElement> }) {
  return (
    <section className="roadmap">
      <div className="roadmap__intro">
        <h1 className="roadmap__title" ref={titleRef} tabIndex={-1}>What’s coming, and when.</h1>
        <p className="roadmap__lead">
          We’re building FortyMM one part at a time. Here’s what we’re working on now and what
          comes after.
        </p>
        <p className="meta">FortyMM is free, and we don’t show ads.</p>
      </div>
      <ol className="roadmap__parts">
        {parts.map(({ title, body, icon, stage }) => (
          <li key={title} data-stage={stage}>
            <span className="roadmap__marker">
              <Icon name={icon} />
            </span>
            <div className="roadmap__part">
              <div className="roadmap__part-head">
                <h2 className="h3">{title}</h2>
                <span className="fm-status">
                  <Icon name={stage === 'ready' ? 'check' : 'clock'} />
                  {stageLabels[stage]}
                </span>
              </div>
              <p>{body}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}
