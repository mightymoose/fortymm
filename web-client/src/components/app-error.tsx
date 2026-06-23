import { useRouter } from '@tanstack/react-router'

import { Wordmark } from '@/components/wordmark'
import './app-error.css'

export interface AppErrorProps {
  error: Error
  reset: () => void
}

/**
 * Error boundary for the `_app` layout route (`errorComponent`). It owns the
 * session bootstrap (#292): if `GET /v1/session` fails after retries,
 * `ensureQueryData` rejects the layout loader. Without a boundary that left
 * every session-gated page (`enabled: session.isSuccess`) disabled and pending
 * — a silent forever-skeleton with no way out. Routing the failure here gives a
 * branded screen with a real retry.
 *
 * Scoped to `_app` rather than a global `defaultErrorComponent` on purpose: this
 * replaces the whole `_app` subtree (AppShell can't render without a session)
 * and stays *outside* any child's own React error boundary — a per-route default
 * would land inside the admin/tournament `RbacBoundary` and shadow its handling.
 *
 * Full-screen and self-themed: it carries its own `dark fortymm-theme` wrapper
 * rather than relying on an ancestor's.
 */
export function AppError({ reset }: AppErrorProps) {
  const router = useRouter()
  return (
    <div className="app-error dark fortymm-theme">
      <Wordmark size={20} className="app-error__wordmark" />
      <div role="alert" className="md-error-state" data-tone="alert">
        <div className="md-error-state__code">
          <span className="md-error-state__dot" aria-hidden="true" />
          Error
        </div>
        <h1 className="md-error-state__title">Something went wrong.</h1>
        <p className="md-error-state__sub">
          We couldn&rsquo;t load the page — could be us, could be the network.
          Try again in a moment.
        </p>
        <div className="md-error-state__actions">
          <button
            type="button"
            className="md-btn md-btn--primary"
            onClick={() => {
              // Reset the router's error boundary, then re-run the loaders so
              // the session bootstrap (and any other failed loader) refetches.
              reset()
              void router.invalidate()
            }}
          >
            Try again
          </button>
          <button
            type="button"
            className="md-btn md-btn--ghost"
            onClick={() => window.location.reload()}
          >
            Reload page
          </button>
        </div>
      </div>
    </div>
  )
}
