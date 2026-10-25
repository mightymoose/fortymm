import { Icon, type IconName } from '../components/Icon'

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
    body: 'Sign in on any device and keep your matches, leagues and rating in one place.',
    icon: 'user',
    stage: 'building',
  },
  {
    title: 'Leagues',
    body: 'Play a season with your club or your friends, and follow the standings.',
    icon: 'list',
    stage: 'next',
  },
  {
    title: 'Matches',
    body: 'Log the matches you play and follow your rating after each one.',
    icon: 'table',
    stage: 'later',
  },
  {
    title: 'Basic tournaments',
    body: 'Run a simple tournament with your friends, from the draw to the final.',
    icon: 'calendar',
    stage: 'later',
  },
]

// What we're building and what comes after, styled by `.roadmap` in
// styles/base.css. Each part's stage sets its colour there.
export function Home() {
  return (
    <section className="roadmap">
      <div className="roadmap__intro">
        <h1 className="roadmap__title">What’s coming, and when.</h1>
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
