import { useEffect, useState } from 'react'

// A page that's ready this soon after it starts loading shows without the
// loading screen, so a fast load doesn't flash it. The `_authenticated`
// route passes it to the router as `pendingMs`.
export const SHOW_AFTER_MS = 300

// Once shown, the loading screen stays up at least this long, so it reads as
// a screen rather than a flash. The router's `pendingMinMs`.
export const MIN_SHOWN_MS = 900

// After this long, the status line says why the load is slow. The API scales
// to zero on Cloud Run, so a cold start can take several seconds.
export const SLOW_AFTER_MS = 4000

export const STATUS = 'Connecting to FortyMM…'
export const SLOW_STATUS =
  'Still connecting. The server can take a few seconds to start.'

// The full-screen FortyMM loading screen: the wordmark and a status line,
// with no motion. The `_authenticated` route shows it as its
// pendingComponent while the session starts, and the page replaces it in
// one frame. Styled by `.loading-screen` in styles/base.css.
export function LoadingScreen() {
  const [slow, setSlow] = useState(false)

  useEffect(() => {
    const id = setTimeout(() => setSlow(true), SLOW_AFTER_MS - SHOW_AFTER_MS)
    return () => clearTimeout(id)
  }, [])

  return (
    <div
      className="loading-screen"
      role="status"
      aria-live="polite"
      aria-label="Loading FortyMM"
    >
      <div className="loading-screen-wordmark">FortyMM</div>
      <p className="loading-screen-status">{slow ? SLOW_STATUS : STATUS}</p>
    </div>
  )
}
