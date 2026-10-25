import { useEffect, useRef, useState } from 'react'

// A page that's ready this soon after the app starts shows without the
// loading screen, so a fast load doesn't flash it.
export const SHOW_AFTER_MS = 300

// Once shown, the loading screen stays up at least this long, so it reads as
// a screen rather than a flash.
export const MIN_SHOWN_MS = 900

// After this long, the status line says why the load is slow. The API scales
// to zero on Cloud Run, so a cold start can take several seconds.
export const SLOW_AFTER_MS = 4000

export const STATUS = 'Connecting to FortyMM…'
export const SLOW_STATUS =
  'Still connecting. The server can take a few seconds to start.'

// How far the timers have got. waiting: not shown yet, and never shown if
// the page is ready first. shown: up for less than MIN_SHOWN_MS. held: up for
// MIN_SHOWN_MS, so it fades out as soon as the page is ready.
type Stage = 'waiting' | 'shown' | 'held'

// The full-screen FortyMM loading screen, shown over the page until it's
// `ready`: the wordmark and a status line, with no motion until it fades
// out. Styled by `.loading-screen` in styles/base.css.
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
  const [slow, setSlow] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const id = setTimeout(() => setSlow(true), SLOW_AFTER_MS)
    return () => clearTimeout(id)
  }, [])

  // A native listener: without AnimationEvent (as in jsdom), React's
  // onAnimationEnd listens for the vendor-prefixed event instead.
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
      <div className="loading-screen-wordmark">FortyMM</div>
      <p className="loading-screen-status">{slow ? SLOW_STATUS : STATUS}</p>
    </div>
  )
}
