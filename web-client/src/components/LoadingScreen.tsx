import { useEffect, useState } from 'react'

const STATUS_STEPS = [
  'Warming up',
  'Setting the net',
  'Seeding the draw',
  'Calling the first match',
]

const STATUS_STEP_MS = 1800

// The full-screen FortyMM loading screen: a ball bouncing on a table surface,
// the wordmark and a status line that moves through STATUS_STEPS. Styled by
// `.loading-screen` in styles/base.css.
export function LoadingScreen() {
  const [step, setStep] = useState(0)

  useEffect(() => {
    const id = setInterval(
      () => setStep((current) => (current + 1) % STATUS_STEPS.length),
      STATUS_STEP_MS,
    )
    return () => clearInterval(id)
  }, [])

  return (
    <div
      className="loading-screen"
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
