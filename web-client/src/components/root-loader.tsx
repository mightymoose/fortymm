import { Wordmark } from '@/components/wordmark'
import './root-loader.css'

// Rotating warm-up copy (FortyMM "Session Loader" handoff, "The Serve").
const WARMUP_LINES = [
  'Warming up the paddles…',
  'Chalking the table lines…',
  'Stringing the net…',
  'Finding your rating…',
  'Almost ready…',
]

/**
 * Full-screen loading state shown by the `_app` layout route while its loader
 * establishes the session (mints/loads the guest before any in-app BFF query
 * fires — the waterfall that keeps the displayed identity in sync with the
 * session cookie, #487).
 *
 * "The Serve" direction from the design handoff: a pulsing brand core inside
 * three expanding serve rings, with rotating warm-up lines beneath. The router
 * crossfades to the page once the loader settles, so no hand-off animation
 * lives here.
 */
export function RootLoader() {
  return (
    <div className="root-loader" role="status" aria-live="polite" aria-busy="true">
      <Wordmark size={20} className="root-loader__wordmark" />

      <div className="root-loader__beacon" aria-hidden="true">
        <span className="root-loader__ring" />
        <span className="root-loader__ring" />
        <span className="root-loader__ring" />
        <span className="root-loader__core" />
      </div>

      <div className="root-loader__lines" aria-hidden="true">
        {WARMUP_LINES.map((line) => (
          <span key={line} className="root-loader__line">
            {line}
          </span>
        ))}
      </div>

      <span className="sr-only">Setting up your session…</span>
    </div>
  )
}
