import { useEffect, useRef, useState } from 'react'

const STATUS_STEPS = [
  'Warming up',
  'Setting the net',
  'Seeding the draw',
  'Calling the first match',
]

const STATUS_STEP_MS = 1800

// A page that's ready this soon after the app starts shows without the
// loading screen, so a fast load doesn't flash it.
export const SHOW_AFTER_MS = 300

// Once shown, the loading screen stays up for at least one bounce of the ball
// (`--loading-screen-bounce-duration` in styles/base.css).
export const MIN_SHOWN_MS = 900

// How far the timers have got. waiting: not shown yet, and never shown if
// the page is ready first. shown: up for less than MIN_SHOWN_MS. held: up for
// MIN_SHOWN_MS, so it fades out as soon as the page is ready.
type Stage = 'waiting' | 'shown' | 'held'

// The full-screen FortyMM loading screen, shown over the page until it's
// `ready`: a ball bouncing on a table surface, the wordmark and a status line
// that moves through STATUS_STEPS. Styled by `.loading-screen` in
// styles/base.css.
export function LoadingScreen({ ready }: { ready: boolean }) {
  const [stage, setStage] = useState<Stage>('waiting')
  const [faded, setFaded] = useState(false)

  useEffect(() => {
    if (stage === 'waiting' && !ready) {
      const id = setTimeout(() => setStage('shown'), SHOW_AFTER_MS)
      return () => clearTimeout(id)
    }
    if (stage === 'shown') {
      const id = setTimeout(() => setStage('held'), MIN_SHOWN_MS)
      return () => clearTimeout(id)
    }
  }, [stage, ready])

  if (stage === 'waiting' || faded) return null
  return (
    <LoadingScreenView
      leaving={stage === 'held' && ready}
      onLeft={() => setFaded(true)}
    />
  )
}

function LoadingScreenView({
  leaving,
  onLeft,
}: {
  leaving: boolean
  onLeft: () => void
}) {
  const [step, setStep] = useState(0)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const id = setInterval(
      () => setStep((current) => (current + 1) % STATUS_STEPS.length),
      STATUS_STEP_MS,
    )
    return () => clearInterval(id)
  }, [])

  // A native listener: without AnimationEvent (as in jsdom), React's
  // onAnimationEnd listens for the vendor-prefixed event instead. The ball's
  // and contact mark's animations never end, so only the fade-out ends here.
  useEffect(() => {
    const element = ref.current!
    const onAnimationEnd = (event: Event) => {
      if (event.target === element) onLeft()
    }
    element.addEventListener('animationend', onAnimationEnd)
    return () => element.removeEventListener('animationend', onAnimationEnd)
  }, [onLeft])

  return (
    <div
      ref={ref}
      className={leaving ? 'loading-screen loading-screen-leaving' : 'loading-screen'}
      role="status"
      aria-live="polite"
      aria-label="Loading FortyMM"
    >
      <div className="loading-screen-body">
        <div className="loading-screen-arena" aria-hidden="true">
          <div className="loading-screen-surface" />
          <div className="loading-screen-contact" />
          <div className="loading-screen-ball" />
        </div>
        <div className="loading-screen-text">
          <div className="loading-screen-wordmark">FortyMM</div>
          <div className="loading-screen-status">{STATUS_STEPS[step]}…</div>
        </div>
      </div>
      <div className="loading-screen-footer">Play more. Pay never.</div>
    </div>
  )
}
