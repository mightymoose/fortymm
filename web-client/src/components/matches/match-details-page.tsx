import { Link, useRouter } from '@tanstack/react-router'

import { HeadToHead } from './match-details/head-to-head'
import { MatchInfo } from './match-details/match-info'
import { PlayersPanel } from './match-details/players-panel'
import { Ratings } from './match-details/ratings'
import { Scoreboard } from './match-details/scoreboard'
import { AppShell } from '@/components/app-shell'
import { Overline } from '@/components/overline'
import {
  scoringNewRoute,
  useConfirmMatch,
  useDisputeMatch,
  useFinalizeMatch,
  useMatch,
} from '@/api/matches'
import type { components } from '@/api/schema'
import { ApiError } from '@/api/client'

import { SaveYourMatch } from './save-your-match'

type MatchDetails = components['schemas']['app__schemas__match__MatchDetails']
type MatchResultsGameWrite = components['schemas']['MatchResultsGameWrite']
type MatchDetailsSide = components['schemas']['MatchDetailsSide']

type HeroState = 'live' | 'final' | 'upcoming'

type SideView = {
  sideNumber: number
  username: string
}

export type MatchView = {
  statusLabel: string
  bestOf: number
  gamesToWin: number
  rated: boolean
  // Left/right are perspective-relative: when the current user is on a side
  // they're left; otherwise left = side 1, right = side 2.
  leftSide: SideView
  rightSide: SideView | null
  scoreCta: { matchId: string; gameNumber: number } | null
  // True when the caller can hit either ``POST /confirmation`` or
  // ``POST /dispute`` — surfaces the Confirm / Dispute CTAs.
  canConfirm: boolean
  // The canonical games to re-post when the saved scores form a decided, valid,
  // unsigned match (i.e. `can_finalize`). Non-null drives the "Post result"
  // callout, which doubles as the one-click resubmit after a mistaken dispute;
  // null when there's nothing postable.
  resubmitGames: MatchResultsGameWrite[] | null
  // True when there's at least one signature AND the current user is among
  // the signers — surfaces the passive "Awaiting <opponent>'s confirmation"
  // indicator (we already signed; waiting on the other side).
  viewerIsAwaitingOther: boolean
  // The user whose signature we're waiting on, for the passive label. Null
  // when there's no posted result, or when the viewer isn't a participant.
  pendingSignerName: string | null
}

function projectSide(side: MatchDetailsSide, fallbackLabel: string): SideView {
  const player = side.players[0]
  return {
    sideNumber: side.side_number,
    username: player?.username ?? fallbackLabel,
  }
}

function orderSides(sides: MatchDetailsSide[]): {
  leftSide: MatchDetailsSide
  rightSide: MatchDetailsSide | null
} {
  const bySideNumber = [...sides].sort(
    (a, b) => a.side_number - b.side_number,
  )
  const mine = bySideNumber.find((s) => s.is_current_user_side)
  if (mine) {
    const opp = bySideNumber.find((s) => !s.is_current_user_side) ?? null
    return { leftSide: mine, rightSide: opp }
  }
  return {
    leftSide: bySideNumber[0],
    rightSide: bySideNumber[1] ?? null,
  }
}

function projectMatchView(data: MatchDetails, matchId: string): MatchView {
  // Hero state comes from the new scoreboard view model (data.data.scoreboard),
  // which collapses the lifecycle to the same scheduled/live/final buckets the
  // matches list uses — so disputed/voided read as `final`, not `upcoming`.
  const state: HeroState =
    data.data.scoreboard.status === 'live'
      ? 'live'
      : data.data.scoreboard.status === 'final'
        ? 'final'
        : 'upcoming'
  const { leftSide, rightSide } = orderSides(data.sides)
  const viewerIsParticipant = leftSide.is_current_user_side
  const leftLabel = viewerIsParticipant ? 'You' : 'Side 1'
  const rightLabel = viewerIsParticipant ? 'Opponent' : 'Side 2'
  const leftView = projectSide(leftSide, leftLabel)
  const rightView = rightSide ? projectSide(rightSide, rightLabel) : null
  const scoreCta =
    data.can_score && data.current_game
      ? { matchId, gameNumber: data.current_game.game_number }
      : null

  // Awaiting-confirmation indicator: which side hasn't signed yet, surfaced
  // by username for the passive "Awaiting <opp>" copy when the viewer has
  // already signed. Null when there's no posted result, or the viewer can't
  // see this state (anonymous, non-participant, etc.).
  //
  // Gated on the live (``in_progress``) state: a posted result keeps the match
  // in_progress until the other side signs, at which point /confirmation flips
  // it to ``completed``. Once finalized (or disputed/voided) the signatures
  // still exist, so without this status check the passive notice would linger
  // above a Final match — even across a reload. See #358.
  const signers = new Set(data.signatures.map((sig) => sig.user_id))
  const viewerUserId = viewerIsParticipant
    ? (leftSide.players[0]?.user_id ?? null)
    : null
  const viewerHasSigned =
    viewerUserId !== null && signers.has(viewerUserId)
  const viewerIsAwaitingOther =
    state === 'live' &&
    viewerIsParticipant &&
    data.signatures.length > 0 &&
    viewerHasSigned
  // Find the participant who's missing from the signature set. With "at
  // least one player per side" semantics, this picks the first un-signed
  // player on the other side. Falls back to "your opponent" if we can't
  // resolve a name.
  let pendingSignerName: string | null = null
  if (viewerIsAwaitingOther && rightSide) {
    const missing = rightSide.players.find((p) => !signers.has(p.user_id))
    pendingSignerName = missing?.username ?? 'your opponent'
  }

  // The canonical games to re-post when the board is decided but unsigned.
  // Built from the saved (perspective-agnostic) side-1/side-2 scores so a
  // one-click "Post result" sends exactly what's on the board.
  const resubmitGames: MatchResultsGameWrite[] | null = data.can_finalize
    ? data.games
        .filter((g) => g.score)
        .sort((a, b) => a.game_number - b.game_number)
        .map((g) => ({
          game_number: g.game_number,
          side_1_points: g.score!.side_1_points,
          side_2_points: g.score!.side_2_points,
        }))
    : null

  return {
    statusLabel: data.status_label,
    bestOf: data.best_of,
    gamesToWin: data.games_to_win,
    rated: data.affects_rating,
    leftSide: leftView,
    rightSide: rightView,
    scoreCta,
    canConfirm: data.can_confirm,
    resubmitGames,
    viewerIsAwaitingOther,
    pendingSignerName,
  }
}

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
  const { data, isLoading } = useMatch(matchId)

  const body =
    isLoading || !data ? (
      <MatchDetailsSkeleton />
    ) : (
      <MatchDetailsPage
        view={projectMatchView(data, matchId)}
        matchId={matchId}
        standalone={standalone}
      />
    )
  return standalone ? body : <AppShell>{body}</AppShell>
}

export function MatchDetailsError({
  error,
  reset,
  standalone = false,
}: {
  error: Error
  reset: () => void
  /** Mirror of `MatchDetailsView`'s standalone — skip AppShell on the public
   * route, and drop the "Back to matches" affordance (anonymous viewers
   * can't reach /matches). */
  standalone?: boolean
}) {
  const router = useRouter()
  const status = error instanceof ApiError ? error.status : 0
  // Any client error (404 no-such-match, 422 malformed id, …) means there's no
  // viewable match at this URL — show the friendly copy and never leak the raw
  // API detail (e.g. the pydantic "Input should be a valid UUID" string, #152).
  // Retrying the same URL won't help, so offer a way back to the list instead.
  const notFound = status >= 400 && status < 500
  const message = notFound
    ? "We couldn't find that match."
    : 'Something went wrong loading this match.'
  const body = (
    <div role="alert" className="md-error-state">
      <div className="md-error-state__title">{message}</div>
      {notFound ? (
        // The public route has no /matches index to send anonymous viewers
        // to; for them the 404 page stops at the message.
        standalone ? null : (
          <Link to="/matches" className="md-btn md-btn--secondary">
            Back to matches
          </Link>
        )
      ) : (
        <button
          type="button"
          className="md-btn md-btn--secondary"
          onClick={() => {
            reset()
            router.invalidate()
          }}
        >
          Try again
        </button>
      )}
    </div>
  )
  return standalone ? body : <AppShell>{body}</AppShell>
}

function MatchDetailsSkeleton() {
  return (
    <div className="match-details" aria-busy="true">
      <main className="md-page md-page--y">
        <section className="md-hero md-hero--skeleton" />
        <div className="md-card md-card--skeleton" />
      </main>
    </div>
  )
}

function MatchDetailsPage({
  view,
  matchId,
  standalone,
}: {
  view: MatchView
  matchId: string
  standalone: boolean
}) {
  return (
    <div className="match-details">
      <main className="md-page md-page--y">
        <div className="md-header">
          <Breadcrumb matchId={matchId} standalone={standalone} />
          <div className="md-header__right">
            {view.scoreCta && (
              <Link
                {...scoringNewRoute(
                  view.scoreCta.matchId,
                  view.scoreCta.gameNumber,
                )}
                className="md-btn md-btn--primary md-btn--sm"
              >
                Score
              </Link>
            )}
          </div>
        </div>

        <ConfirmationCallout view={view} matchId={matchId} />

        <FinalizeCallout view={view} matchId={matchId} />

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

function ConfirmationCallout({
  view,
  matchId,
}: {
  view: MatchView
  matchId: string
}) {
  const confirmMutation = useConfirmMatch(matchId)
  const disputeMutation = useDisputeMatch(matchId)
  const pending = confirmMutation.isPending || disputeMutation.isPending
  // Without throwOnError, a 409 (race: opponent confirmed/disputed first,
  // user double-clicked, etc.) would otherwise vanish — surface it inline
  // so the button doesn't appear inert.
  const mutationError =
    (confirmMutation.error instanceof ApiError
      ? confirmMutation.error
      : null) ??
    (disputeMutation.error instanceof ApiError ? disputeMutation.error : null)

  if (view.canConfirm) {
    return (
      <section
        className="md-confirm-callout md-confirm-callout--featured"
        data-testid="match-confirm-callout"
      >
        <div className="md-confirm-callout__copy">
          <div className="md-confirm-callout__kicker">
            <span className="ball-dot" aria-hidden="true" /> Posted result ·
            awaiting your sign-off
          </div>
          <h3 className="md-confirm-callout__headline">
            Confirm the result to finalize this match.
          </h3>
          <p className="md-confirm-callout__body">
            Your opponent has posted the result below. Confirm if the scores
            are right, or dispute to send the match back to in-progress so the
            wrong game can be re-scored.
          </p>
          {mutationError && (
            <p
              role="alert"
              className="mt-1.5 text-xs text-[color:var(--loss)]"
            >
              {mutationError.detail ?? mutationError.message}
            </p>
          )}
        </div>
        <div className="md-confirm-callout__actions">
          <button
            type="button"
            className="md-btn md-btn--ghost"
            disabled={pending}
            onClick={() => {
              confirmMutation.reset()
              disputeMutation.mutate()
            }}
          >
            {disputeMutation.isPending ? 'Disputing…' : 'Dispute'}
          </button>
          <button
            type="button"
            className="md-btn md-btn--primary"
            disabled={pending}
            onClick={() => {
              disputeMutation.reset()
              confirmMutation.mutate()
            }}
          >
            {confirmMutation.isPending ? 'Confirming…' : 'Confirm result'}
          </button>
        </div>
      </section>
    )
  }

  if (view.viewerIsAwaitingOther && view.pendingSignerName) {
    return (
      <section
        className="md-confirm-callout md-confirm-callout--passive"
        data-testid="match-confirm-callout"
      >
        <div className="md-confirm-callout__copy">
          <Overline as="h3">Posted · awaiting confirmation</Overline>
          <p className="md-confirm-callout__body">
            You've signed off on this result. Waiting on{' '}
            <strong>{view.pendingSignerName}</strong> to confirm or dispute
            before the match is finalized.
          </p>
        </div>
      </section>
    )
  }

  return null
}

function FinalizeCallout({
  view,
  matchId,
}: {
  view: MatchView
  matchId: string
}) {
  const finalizeMutation = useFinalizeMatch(matchId)
  // Only a participant on a decided-but-unsigned board gets here (the backend
  // gates `can_finalize` on participation + validity + no signature). This is
  // the recovery path for scores entered then left unposted, and the one-click
  // resubmit after a mistaken dispute — the scratchpad scores survive a
  // dispute, so re-posting them unchanged drops back into the sign-off flow.
  if (!view.resubmitGames) return null
  const games = view.resubmitGames
  const error =
    finalizeMutation.error instanceof ApiError ? finalizeMutation.error : null
  return (
    <section
      className="md-confirm-callout md-confirm-callout--featured"
      data-testid="match-finalize-callout"
    >
      <div className="md-confirm-callout__copy">
        <div className="md-confirm-callout__kicker">
          <span className="ball-dot" aria-hidden="true" /> Scores ready · not
          yet posted
        </div>
        <h3 className="md-confirm-callout__headline">
          Post this result for your opponent to confirm.
        </h3>
        <p className="md-confirm-callout__body">
          These scores already decide the match but haven't been posted. Post
          them as-is to send the result for sign-off, or edit any game in the
          scoreboard below first.
        </p>
        {error && (
          <p role="alert" className="mt-1.5 text-xs text-[color:var(--loss)]">
            {error.detail ?? error.message}
          </p>
        )}
      </div>
      <div className="md-confirm-callout__actions">
        <button
          type="button"
          className="md-btn md-btn--primary"
          disabled={finalizeMutation.isPending}
          onClick={() => {
            finalizeMutation.reset()
            finalizeMutation.mutate({ games })
          }}
        >
          {finalizeMutation.isPending ? 'Posting…' : 'Post result'}
        </button>
      </div>
    </section>
  )
}
