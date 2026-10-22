import { useEffect, useRef, useState } from 'react'

const STATUS_STEPS = [
  'Warming up',
  'Setting the net',
  'Seeding the draw',
  'Calling the first match',
]

const STATUS_STEP_MS = 1800

// The full-screen FortyMM loading screen: a ball bouncing on a table surface,
// the wordmark and a status line that moves through STATUS_STEPS. Styled by
// `.loading-screen` in styles/base.css. Once `leaving`, it fades out and then
// calls `onLeft`.
export function LoadingScreen({
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
