import { Breadcrumb } from './match-details/breadcrumb'
import { ConfirmationCallout } from './match-details/confirmation-callout'
import { FinalizeCallout } from './match-details/finalize-callout'
import { HeadToHead } from './match-details/head-to-head'
import { MatchInfo } from './match-details/match-info'
import { PlayersPanel } from './match-details/players-panel'
import { Ratings } from './match-details/ratings'
import { Scoreboard } from './match-details/scoreboard'
import { SaveYourMatch } from './match-details/save-your-match'
import { ScoreCta } from './match-details/score-cta'

// `MatchDetailsError` is the error-boundary fallback for this page; it lives in
// its own colocated quartet. Re-exported here so the routes can keep importing
// both halves of the page from one module.
export {
  MatchDetailsError,
  type MatchDetailsErrorProps,
} from './match-details/match-details-error'

export function MatchDetails({ matchId }: { matchId: string }) {
  // Every section below is a self-fetching quartet, so the page renders
  // immediately and each piece suspends independently — no page-level fetch.
  return (
    <div className="match-details">
      <main className="md-page md-page--y">
        <div className="md-header">
          <Breadcrumb matchId={matchId} />
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
      </main>
    </div>
  )
}
