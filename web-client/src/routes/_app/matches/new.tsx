import { useState } from 'react'
import { createFileRoute, useBlocker, useNavigate } from '@tanstack/react-router'
import { ArrowRight, Loader2 } from 'lucide-react'

import { deriveEmailStatus, useSession } from '@/api/session'
import { OpponentPicker } from '@/components/matches/opponent-picker'
import {
  BestOfField,
  type BestOfFieldProps,
} from '@/components/matches/match-setup/best-of-field'
import { RatedField } from '@/components/matches/match-setup/rated-field'
import { SelectedOpponent } from '@/components/matches/match-setup/selected-opponent'
import {
  opponentFromPlayer,
  type Opponent,
} from '@/components/matches/match-setup/opponent'
import { useStartMatch } from '@/components/matches/match-setup/use-start-match'
import { UserAvatar } from '@/components/ui/user-avatar'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { pageTitle } from '@/lib/page-title'
import './new.css'

// The form's untouched defaults — shared between the initial state and the
// dirty check below so the two can't drift apart.
const DEFAULT_BEST_OF = 5
const DEFAULT_RATED = false

export const Route = createFileRoute('/_app/matches/new')({
  head: () => ({
    meta: [{ title: pageTitle('New match') }],
  }),
  component: NewMatchPage,
})

/* ------------------------------------------------------------------ */
/*  Page                                                              */
/* ------------------------------------------------------------------ */

function NewMatchPage() {
  return (
    <>
      <div className="nm-page">
        <div className="nm-page-head">
          <h1>
            New match<span className="dot">.</span>
          </h1>
        </div>
        <MatchCard />
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ */
/*  Match setup card                                                  */
/* ------------------------------------------------------------------ */

function MatchCard() {
  const navigate = useNavigate()
  const { data: session } = useSession()

  const [opponent, setOpponent] = useState<Opponent | null>(null)
  const [bestOf, setBestOf] =
    useState<BestOfFieldProps['bestOf']>(DEFAULT_BEST_OF)
  // Default off so submitting without picking an opponent "just works" —
  // the no-opponent match is unrated by definition.
  const [rated, setRated] = useState(DEFAULT_RATED)
  const { submit, apiError, submitting, submitted, hasSucceeded } =
    useStartMatch()

  // Anything away from the form's defaults means the user has invested effort
  // that leaving would silently destroy (#75).
  const isDirty =
    opponent !== null || bestOf !== DEFAULT_BEST_OF || rated !== DEFAULT_RATED

  // Blocks in-app navigation (Cancel, back button, any other link) and
  // browser refresh/close alike while the form is dirty — the same
  // `useBlocker` + design-system `AlertDialog` pattern already used by
  // settings.tsx (#440) and score-entry.tsx (#441), rather than a bespoke
  // check on just the Cancel button. `hasSucceeded()` reads a ref, not
  // reactive state, so the escape hatch for the post-create redirect sees the
  // true value even if it fires before React re-renders with it (mirrors
  // score-entry.tsx's `submittingRef` guard).
  const blocker = useBlocker({
    shouldBlockFn: () => isDirty && !hasSucceeded(),
    enableBeforeUnload: () => isDirty && !hasSucceeded(),
    withResolver: true,
  })

  const me = session?.data.user ?? null
  // The hint nudges guests toward claiming an account so their rated history
  // survives a cookie wipe. Mirror save-your-match.tsx by using the strictest
  // 'guest' status — users with a pending or confirmed email don't need this.
  const isGuest =
    me != null &&
    deriveEmailStatus({
      email: me.email ?? null,
      confirmedAt: me.confirmed_at ?? null,
      pendingEmail: me.pending_email ?? null,
    }) === 'guest'

  return (
    <div className="nm-card">
      <div className="nm-you-strip">
        <UserAvatar name={me?.username ?? '…'} size={36} dim={!me} />
        <div className="block">
          <span className="lbl">You</span>
          <span className="name">{me?.username ?? 'Loading…'}</span>
        </div>
      </div>

      <div className="nm-opp-block">
        <div className="nm-section-head">
          <span className="title">Opponent</span>
          <span className="hint">
            {opponent ? 'Rated-eligible' : 'Optional · leave blank for a solo match'}
          </span>
        </div>

        {opponent ? (
          <SelectedOpponent
            opponent={opponent}
            // Clearing the opponent must also clear `rated` — otherwise the
            // toggle's "off" appearance (because `effectiveRated` is gated by
            // `ratable`) hides a stored `true` that would either (a) trip the
            // rated-needs-opponent refinement with a disabled toggle the user
            // can't switch off, or (b) silently re-engage rating when a new
            // opponent is picked.
            onChange={() => {
              setOpponent(null)
              setRated(false)
            }}
          />
        ) : (
          <OpponentPicker
            onPick={(player) => setOpponent(opponentFromPlayer(player))}
          />
        )}
      </div>

      <div className="nm-settings">
        <BestOfField bestOf={bestOf} setBestOf={setBestOf} />
        <RatedField
          rated={rated}
          setRated={setRated}
          opponent={opponent}
          isGuest={isGuest}
        />
      </div>

      <SubmitRow
        opponent={opponent}
        bestOf={bestOf}
        rated={rated}
        error={submitted ? apiError : null}
        submitting={submitting}
        onSubmit={() => submit({ opponent, bestOf, rated })}
        onCancel={() => navigate({ to: '/dashboard' })}
      />

      <AlertDialog
        open={blocker.status === 'blocked'}
        onOpenChange={(open) => {
          // Radix fires onOpenChange(false) on overlay click / Escape — treat
          // that as "stay on the page" so a stray dismiss never discards the
          // form.
          if (!open) blocker.reset?.()
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard changes?</AlertDialogTitle>
            <AlertDialogDescription>
              You've picked an opponent or changed the match settings. Leaving
              now discards them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => blocker.reset?.()}>
              Keep editing
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => blocker.proceed?.()}
            >
              Discard &amp; leave
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Submit row                                                        */
/* ------------------------------------------------------------------ */

function SubmitRow({
  opponent,
  bestOf,
  rated,
  error,
  submitting,
  onSubmit,
  onCancel,
}: {
  opponent: Opponent | null
  bestOf: number
  rated: boolean
  error: string | null
  submitting: boolean
  onSubmit: () => void
  onCancel: () => void
}) {
  const effectivelyRated = rated && opponent !== null
  const gamesToWin = Math.ceil(bestOf / 2)
  const lengthCopy =
    bestOf === 1 ? 'Single game' : `Best of ${bestOf} · first to ${gamesToWin}`

  return (
    <div className="nm-summary">
      <div className="read">
        <div className="top">
          {opponent ? (
            <>
              Ready: <b>You</b> vs <b>{opponent.name}</b>
            </>
          ) : (
            <>
              Ready: <b>You</b> <span className="opp-tbd">· solo match</span>
            </>
          )}
        </div>
        <div className="sub">
          {lengthCopy}{' '}
          <span className="dot">·</span>{' '}
          {effectivelyRated ? (
            <span className="rated">Rated</span>
          ) : (
            <span className="unrated">Unrated</span>
          )}{' '}
          <span className="dot">·</span>{' '}
          games to 11, win by 2
        </div>
        {error && (
          <p className="nm-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="actions">
        <button
          type="button"
          className="nm-btn nm-btn-ghost"
          onClick={onCancel}
          disabled={submitting}
        >
          Cancel
        </button>
        <button
          type="button"
          className={`nm-btn nm-btn-primary${submitting ? ' nm-btn-pending' : ''}`}
          onClick={onSubmit}
          disabled={submitting}
        >
          {submitting && (
            <Loader2 className="fmm-icon-spin" size={16} strokeWidth={2.5} />
          )}
          {submitting ? 'Starting…' : 'Start match'}
          {!submitting && <ArrowRight size={16} strokeWidth={2.5} />}
        </button>
      </div>
    </div>
  )
}
