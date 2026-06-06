import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'

import { deriveEmailStatus, useSession } from '@/api/session'
import { fmtDate } from '@/lib/dates'
import { cn } from '@/lib/utils'

import type { MatchView } from './match-details-page'

// Per-match key. Dismissing on one finalized match doesn't quiet the prompt
// on the next — a guest with multiple matches still gets the nudge once per
// result they care about.
const DISMISS_KEY_PREFIX = 'fm.savePromptDismissed.'
const SETTINGS_EMAIL_HASH = 'sec-email'

function readDismissed(matchId: string): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(DISMISS_KEY_PREFIX + matchId) === '1'
  } catch {
    return false
  }
}

function writeDismissed(matchId: string, value: boolean) {
  if (typeof window === 'undefined') return
  try {
    if (value) {
      window.localStorage.setItem(DISMISS_KEY_PREFIX + matchId, '1')
    } else {
      window.localStorage.removeItem(DISMISS_KEY_PREFIX + matchId)
    }
  } catch {
    /* private mode / quota — fail open; better to re-nudge than crash */
  }
}

function MatchAnchor({ view }: { view: MatchView }) {
  // The outer gate guarantees a real opponent on the right side; we can
  // dereference freely here.
  const me = view.leftSide
  const opp = view.rightSide!
  const iWon = me.won === true
  return (
    <div className="md-save__anchor" aria-label="Match summary">
      <div
        className={cn(
          'md-avatar md-save__avatar',
          iWon ? 'md-avatar--win' : 'md-avatar--loss',
        )}
      >
        {me.initials}
      </div>
      <div className="md-save__blips">
        <span className={cn('md-save__blip', iWon && 'md-save__blip--win')}>
          {me.gamesWon}
        </span>
        <span className="md-save__blip-dash">–</span>
        <span className={cn('md-save__blip', !iWon && 'md-save__blip--win')}>
          {opp.gamesWon}
        </span>
      </div>
      <div
        className={cn(
          'md-avatar md-save__avatar',
          iWon ? 'md-avatar--loss' : 'md-avatar--win',
        )}
      >
        {opp.initials}
      </div>
      <span className="md-save__date">{fmtDate(view.createdAt).toUpperCase()}</span>
    </div>
  )
}

function DismissedReceipt() {
  // The receipt sticks around for the rest of the session after "Not now",
  // so the user has a recoverable affordance without a re-nudge. "Save it"
  // routes straight to the email flow — the label promises a commit, not an
  // undo, so we navigate rather than restore the prompt.
  return (
    <div className="md-save-receipt" role="status">
      <span aria-hidden="true">—</span>
      <span>
        This match lives on your device only.{' '}
        <Link
          to="/settings"
          hash={SETTINGS_EMAIL_HASH}
          className="md-save-receipt__undo"
        >
          Save it
        </Link>{' '}
        to keep it.
      </span>
    </div>
  )
}

export function SaveYourMatch({
  view,
  matchId,
}: {
  view: MatchView
  matchId: string
}) {
  // Cheap, props-only gates first so we never call useSession() (and thereby
  // mint a guest user via GET /v1/session) on the standalone public-share
  // route where the viewer is never the participant. The inner body owns the
  // hook tree so the conditional return here doesn't change hook order.
  // Show as soon as the match is being played — we don't wait for opponent
  // sign-off. The "save it before cookies clear" risk applies the moment the
  // guest has invested any real time, not just at the rated-finalized
  // boundary (which can be hours later, after the guest has closed the tab).
  if (view.state === 'upcoming') return null
  if (!view.leftSide.isCurrentUser) return null
  if (!view.rightSide || view.rightSide.isGhost) return null
  return <SaveYourMatchActive view={view} matchId={matchId} />
}

function SaveYourMatchActive({
  view,
  matchId,
}: {
  view: MatchView
  matchId: string
}) {
  const { data: session } = useSession()

  // 'cold' = dismissed on a prior visit (read from localStorage). We hide
  // entirely in that case — the brief is explicit: don't badger on revisit.
  // 'session' = dismissed in this session — we swap in a quiet receipt so the
  // user can still find their way back to the email flow without a re-nudge.
  const [dismissed, setDismissed] = useState<'cold' | 'session' | false>(() =>
    readDismissed(matchId) ? 'cold' : false,
  )

  const user = session?.data.user
  if (!user) return null
  // Reuse the canonical guest/pending/verified split from /settings so this
  // prompt and the topbar UserMenu agree on who counts as a guest (e.g. a
  // user with `pending_email` is no longer "guest", they're "pending").
  const isGuest =
    deriveEmailStatus({
      email: user.email ?? null,
      confirmedAt: user.confirmed_at ?? null,
      pendingEmail: user.pending_email ?? null,
    }) === 'guest'
  if (!isGuest) return null

  if (dismissed === 'cold') return null
  if (dismissed === 'session') return <DismissedReceipt />

  const handleDismiss = () => {
    writeDismissed(matchId, true)
    setDismissed('session')
  }

  return (
    <section
      className={cn('md-save', view.canConfirm && 'md-save--soft')}
      aria-label="Save this match"
    >
      <div className="md-save__hd">
        <div className="md-save__kicker">
          <span className="ball-dot" aria-hidden="true" /> Nice match
        </div>
        <MatchAnchor view={view} />
      </div>

      <div>
        <h3 className="md-save__headline">
          Let&rsquo;s make sure this one sticks around.
        </h3>
        <p className="md-save__body">
          Add an email and your rating and rivalry with {view.rightSide!.username}{' '}
          are saved across devices. Right now, clearing cookies erases this
          match.
        </p>
      </div>

      <div className="md-save__actions">
        <Link
          to="/settings"
          hash={SETTINGS_EMAIL_HASH}
          className="md-btn md-btn--primary"
        >
          Save this match
          <ChevronRight size={14} />
        </Link>
        <button
          type="button"
          className="md-btn md-btn--ghost"
          onClick={handleDismiss}
        >
          Not now
        </button>
        <span className="md-save__hint">TAKES 20s · EMAIL ONLY</span>
      </div>
    </section>
  )
}
