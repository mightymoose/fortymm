import { Link } from '@tanstack/react-router'

import { ConfirmationCallout } from './match-details/confirmation-callout'
import { FinalizeCallout } from './match-details/finalize-callout'
import { HeadToHead } from './match-details/head-to-head'
import { MatchInfo } from './match-details/match-info'
import { PlayersPanel } from './match-details/players-panel'
import { Ratings } from './match-details/ratings'
import { Scoreboard } from './match-details/scoreboard'
import { SaveYourMatch } from './match-details/save-your-match'
import { ScoreCta } from './match-details/score-cta'
import { AppShell } from '@/components/app-shell'

// `MatchDetailsError` is the error-boundary fallback for this page; it now
// lives in its own colocated quartet. Re-exported here so the routes can keep
// importing both halves of the page from one module.
export {
  MatchDetailsError,
  type MatchDetailsErrorProps,
} from './match-details/match-details-error'

export function MatchDetailsView({
  matchId,
  standalone = false,
}: {
  matchId: string
  /** When true, render without AppShell — used by the public `/p/matches`
   * route which has no signed-in user to drive the nav sidebar. Also
   * suppresses the "Matches" breadcrumb crumb, which would 401 an anonymous
   * viewer. */
  standalone?: boolean
}) {
  // Every section below is a self-fetching quartet, so the page renders
  // immediately and each piece suspends independently — no page-level fetch.
  const body = <MatchDetailsPage matchId={matchId} standalone={standalone} />
  return standalone ? body : <AppShell>{body}</AppShell>
}

function MatchDetailsPage({
  matchId,
  standalone,
}: {
  matchId: string
  standalone: boolean
}) {
  return (
    <div className="match-details">
      <main className="md-page md-page--y">
        <div className="md-header">
          <Breadcrumb matchId={matchId} standalone={standalone} />
          <div className="md-header__right">
            <ScoreCta matchId={matchId} />
          </div>
        </div>

        <ConfirmationCallout matchId={matchId} />

        <FinalizeCallout matchId={matchId} />

        <SaveYourMatch key={matchId} matchId={matchId} />

        <Scoreboard matchId={matchId} />

        <div className="md-col-2">
          <div className="md-col-2__main">
            <PlayersPanel matchId={matchId} />
          </div>
          <aside className="md-col-2__aside">
            <MatchInfo matchId={matchId} />
            <Ratings matchId={matchId} />
            <HeadToHead matchId={matchId} />
          </aside>
        </div>

        <footer className="md-footer">
          <div className="md-footer__tagline">
            <Logo size={20} />
            <span>The math is quiet. The rallies are loud.</span>
          </div>
          <div className="md-footer__links">
            <a>Manifesto</a>
            <a>Open source</a>
            <a>Made by players</a>
          </div>
        </footer>
      </main>
    </div>
  )
}

function Logo({ size = 26 }: { size?: number }) {
  return (
    <div className="md-logo">
      <svg width={size} height={size} viewBox="0 0 80 80" aria-hidden="true">
        <defs>
          <radialGradient id="md-logo-grad" cx="35%" cy="35%" r="65%">
            <stop offset="0%" stopColor="#FFB57A" />
            <stop offset="55%" stopColor="#FF7A1A" />
            <stop offset="100%" stopColor="#B94700" />
          </radialGradient>
        </defs>
        <circle cx="40" cy="40" r="36" fill="url(#md-logo-grad)" />
        <ellipse cx="30" cy="28" rx="10" ry="6" fill="#FFF" fillOpacity="0.22" />
      </svg>
      <span className="md-logo__word" style={{ fontSize: size * 0.95 }}>
        FORTYMM<span className="accent">.</span>
      </span>
    </div>
  )
}

function Breadcrumb({
  matchId,
  standalone,
}: {
  matchId: string
  standalone: boolean
}) {
  // On the public route there's no /matches index for anonymous viewers, so
  // collapse the breadcrumb to just the current match label.
  if (standalone) {
    return (
      <div className="md-breadcrumb">
        <span className="md-breadcrumb__current">
          Match {matchId.slice(0, 6)}
        </span>
      </div>
    )
  }
  return (
    <div className="md-breadcrumb">
      <Link to="/matches">Matches</Link>
      <span>›</span>
      <span className="md-breadcrumb__current">Match {matchId.slice(0, 6)}</span>
    </div>
  )
}
