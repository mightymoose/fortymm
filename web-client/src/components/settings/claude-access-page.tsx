import { useQuery } from '@tanstack/react-query'

import {
  claudeAccessLoadFailedView,
  claudeAccessQuery,
} from './claude-access-page/claude-access-query'
import { ClaudeAccessView } from './claude-access-page/claude-access-view'
import './claude-access-page/claude-access.css'

/**
 * `/settings/claude` — whether an AI assistant can act on this account, what
 * that would let it do, and how to set it up.
 *
 * A failed load renders the same fail-closed `unavailable` row as a deployment
 * with no connector, rather than an error screen: the accordions below are
 * useful either way, and the row's copy ("we couldn't load your account and
 * connector details") is already exactly what happened. What it must never do
 * is render the setup panel or the connected card with empty fields — which is
 * why the failure has a view of its own instead of a nullable payload threaded
 * through the display.
 */
export function ClaudeAccessPage() {
  const { data, isPending } = useQuery(claudeAccessQuery())

  return (
    <div className="fmm-claude">
      <div className="fmm-claude__inner">
        <header className="fmm-claude__header">
          <p className="fmm-claude__overline">
            <span className="ball-dot" aria-hidden="true" />
            Settings
          </p>
          <h1 className="fmm-claude__title">Claude access</h1>
          <p className="fmm-claude__lede">
            Say what happened and Claude logs the match, checks your rating, or
            sets up a draw — as you, in your account.
          </p>
        </header>
        {isPending ? (
          <p className="fmm-claude__loading">Loading your Claude access…</p>
        ) : (
          // Keyed off the ABSENCE of data, not off `isError`: React Query sets
          // `status: 'error'` on a failed *background* refetch even when a good
          // payload is already cached (see web-client/CLAUDE.md), and blanking
          // a correctly-rendered connected card because one poll blipped would
          // tell a player their agent is disconnected when it isn't.
          <ClaudeAccessView view={data ?? claudeAccessLoadFailedView()} />
        )}
      </div>
    </div>
  )
}
