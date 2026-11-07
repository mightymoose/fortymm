import { Link, useParams, useRouter, type ErrorComponentProps } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { ApiError, ApiUnreachable } from '../../api/errors'
import { ErrorScreen } from '../../components/ErrorScreen'
import { Icon } from '../../components/Icon'
import { QueryError } from '../../components/QueryBoundary'
import { Wordmark } from '../../components/Wordmark'
import { ROUTE } from './sides'
import './scoring.css'

function ScoreFrame({ children }: { children: ReactNode }) {
  return (
    <div className="score-page">
      <header className="score-top">
        <Wordmark />
        <Link to="/" className="fm-btn fm-btn--ghost fm-btn--sm">
          <Icon name="back" />
          Home
        </Link>
      </header>
      <main className="score-content">{children}</main>
    </div>
  )
}

export function ScoresLoading() {
  return (
    <ScoreFrame>
      <span className="fm-sr" role="status">
        Loading scores
      </span>
      <div className="fm-skeleton score-skel--title" aria-hidden="true" />
      <div className="fm-skeleton score-skel--pad" aria-hidden="true" />
      <div className="fm-skeleton score-skel--strip" aria-hidden="true" />
    </ScoreFrame>
  )
}

export function ScoresFailed({ error }: ErrorComponentProps) {
  const router = useRouter()
  // Try again can't fix a bug in the page, so the root error page shows it.
  if (!(error instanceof ApiError || error instanceof ApiUnreachable)) throw error
  return (
    <ScoreFrame>
      <QueryError error={error} onRetry={() => void router.invalidate()} />
    </ScoreFrame>
  )
}

// The URL carries no scores for the match, and with no network the route
// couldn't load them.
export function ScoresUnreachable() {
  const { matchId } = useParams({ from: ROUTE })
  return (
    <ErrorScreen
      title="This match’s scores aren’t on this device"
      actions={
        <Link to="/matches/$matchId" params={{ matchId }} className="fm-btn fm-btn--primary">
          Open the match
        </Link>
      }
    >
      Open this match once with signal, then keep score from its page.
    </ErrorScreen>
  )
}
