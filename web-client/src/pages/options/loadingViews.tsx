import { useEffect, useState, type AnimationEvent, type ReactNode } from 'react'
import { Icon } from '../../components/Icon'

// What every loading-screen option gets from its preview. `leaving` starts
// the fade-out, and `onLeft` is called when it ends.
export type LoadingViewProps = { leaving: boolean; onLeft: () => void }

// How long a load runs before the status line says why it's slow. Cloud Run
// scales to zero, so a cold start can take several seconds.
const SLOW_AFTER_MS = 4000

const slowText = 'Still connecting. The server can take a few seconds to start.'

// Whether SLOW_AFTER_MS has passed since the view appeared.
function useSlow(): boolean {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const id = setTimeout(() => setSlow(true), SLOW_AFTER_MS)
    return () => clearTimeout(id)
  }, [])
  return slow
}

// Calls `onLeft` when the element's own fade-out ends, not a child's.
const endsFade =
  (onLeft: () => void) => (event: AnimationEvent<HTMLElement>) => {
    if (event.target === event.currentTarget) onLeft()
  }

// A full cover over the page, as the real loading screen is, but filling
// its preview frame instead of the window.
function Cover({
  leaving,
  onLeft,
  className,
  children,
}: LoadingViewProps & { className?: string; children: ReactNode }) {
  const classes = ['opt-screen']
  if (className) classes.push(className)
  if (leaving) classes.push('opt-leaving')
  return (
    <div
      className={classes.join(' ')}
      role="status"
      aria-live="polite"
      aria-label="Loading FortyMM"
      onAnimationEnd={endsFade(onLeft)}
    >
      {children}
    </div>
  )
}

// The wordmark and one status line. Nothing moves until the fade-out.
export function LoadingStill(props: LoadingViewProps) {
  const slow = useSlow()
  return (
    <Cover {...props}>
      <div className="opt-wordmark">FortyMM</div>
      <p className="opt-status">{slow ? slowText : 'Connecting to FortyMM…'}</p>
    </Cover>
  )
}

type Step = { doing: string; done: string; at: number | null }

// The work a full page load really does. The app has loaded by the time
// this shows. The server step ends when the health check answers, here
// after a set time. The page step ends when the page is ready.
const steps: readonly Step[] = [
  { doing: 'Loading the app…', done: 'App loaded', at: 0 },
  { doing: 'Reaching the server…', done: 'Server reached', at: 1200 },
  { doing: 'Opening your page…', done: 'Page open', at: null },
]

// A check for each step as it finishes. No spinner: the step in progress
// is the one in bright text.
export function LoadingProgress(props: LoadingViewProps) {
  const [done, setDone] = useState(1)
  const slow = useSlow()
  useEffect(() => {
    const ids = steps.flatMap((step, index) =>
      step.at ? [setTimeout(() => setDone(index + 1), step.at)] : [],
    )
    return () => ids.forEach(clearTimeout)
  }, [])
  return (
    <Cover {...props} className="opt-screen--progress">
      <div className="opt-wordmark opt-wordmark--sm">FortyMM</div>
      <ol className="opt-steps">
        {steps.map((step, index) => {
          const state = index < done ? 'done' : index === done ? 'doing' : 'todo'
          return (
            <li key={step.done} className="opt-step" data-state={state}>
              {state === 'done' ? <Icon name="check" /> : <span className="opt-step__dot" />}
              {state === 'done' ? step.done : step.doing}
            </li>
          )
        })}
      </ol>
      {slow && done < 2 && <p className="opt-status">{slowText}</p>}
    </Cover>
  )
}

// A stand-in for the app's header, in the preview frames.
export function AppChrome() {
  return (
    <div className="opt-chrome">
      <span className="opt-wordmark opt-wordmark--xs">FortyMM</span>
      <span className="opt-chrome__links" aria-hidden="true">
        <span>Matches</span>
        <span>Tournaments</span>
        <span>Clubs</span>
      </span>
    </div>
  )
}

// The app's header at once, and a notice where the page will go. There's
// no cover, so the notice is what fades out.
export function LoadingFrame({ leaving, onLeft }: LoadingViewProps) {
  const slow = useSlow()
  return (
    <div className="opt-screen opt-screen--frame">
      <AppChrome />
      <p
        className={leaving ? 'fm-notice opt-frame-notice opt-leaving' : 'fm-notice opt-frame-notice'}
        role="status"
        aria-live="polite"
        aria-label="Loading FortyMM"
        onAnimationEnd={endsFade(onLeft)}
      >
        <Icon name="info" />
        <span>{slow ? slowText : 'Connecting to FortyMM…'}</span>
      </p>
    </div>
  )
}

// The ball drops once onto the line and stops, then the wordmark appears.
// Both finish inside the loading screen's 900ms minimum, then nothing moves.
export function LoadingLanding(props: LoadingViewProps) {
  const slow = useSlow()
  return (
    <Cover {...props}>
      <div className="opt-landing" aria-hidden="true">
        <span className="opt-landing__ball" />
        <span className="opt-landing__line" />
      </div>
      <div className="opt-landing__text">
        <div className="opt-wordmark">FortyMM</div>
        <p className="opt-status">{slow ? slowText : 'Connecting to FortyMM…'}</p>
      </div>
    </Cover>
  )
}
