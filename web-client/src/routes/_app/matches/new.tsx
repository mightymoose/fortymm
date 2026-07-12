import { useState } from 'react'
import { createFileRoute, useBlocker, useNavigate } from '@tanstack/react-router'
import { zodValidator } from '@tanstack/zod-adapter'
import { z } from 'zod'
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
import {
  opponentSelection,
  selectedOpponent,
  type OpponentSelection,
} from '@/components/matches/match-setup/opponent-selection'
import { usePreselectedOpponent } from '@/components/matches/match-setup/use-preselected-opponent'
import { useStartMatch } from '@/components/matches/match-setup/use-start-match'
import { DiscardMatchSetupDialog } from '@/components/matches/match-setup/discard-match-setup-dialog'
import { UserAvatar } from '@/components/ui/user-avatar'
import { pageTitle } from '@/lib/page-title'
import './new.css'

// The form's untouched defaults — shared between the initial state and the
// dirty check below so the two can't drift apart.
const DEFAULT_BEST_OF = 5
const DEFAULT_RATED = false

/**
 * `?opponent=<userId>` preseeds the opponent slot — the "Start a match" call to
 * action on another player's profile arrives here with them already picked.
 *
 * Parsed at the boundary, and `.catch`-ed rather than thrown (same shape as the
 * profile's `?page=`): a mangled value degrades to the empty picker instead of
 * erroring the page. Deliberately *not* a uuid check — player ids are opaque to
 * the client (the MSW/dev roster uses `pl-1`-style ids), and a well-formed id
 * that names nobody has to degrade the same way regardless, via the 404 on the
 * lookup. So the schema only guarantees "a non-empty string", and the lookup
 * decides whether it's real.
 */
const newMatchSearchSchema = z.object({
  opponent: z.string().trim().min(1).optional().catch(undefined),
})

export const Route = createFileRoute('/_app/matches/new')({
  head: () => ({
    meta: [{ title: pageTitle('New match') }],
  }),
  validateSearch: zodValidator(newMatchSearchSchema),
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

  // An opponent named in the URL preseeds the slot; see `newMatchSearchSchema`.
  const { opponent: preselectedId } = Route.useSearch()
  const preselected = usePreselectedOpponent(preselectedId)

  // `undefined` means the user hasn't touched the opponent slot, so whatever the
  // URL preseeded stands. Any explicit choice — including clearing back to a
  // solo match (`null`) — overrides it from then on.
  const [pick, setPick] = useState<Opponent | null | undefined>(undefined)
  const opponent = pick === undefined ? preselected.opponent : pick

  // The picker's uncommitted search text, mirrored up here via its
  // `onQueryChange` channel. Deliberately its own state and NOT folded into the
  // `pick` tri-state above: `pick`'s `undefined` carries a different, load-bearing
  // meaning ("untouched → the URL preseed stands"), and it is what the discard
  // dialog's dirty check keys off (#75). Half-typing a name is not a touch of the
  // opponent slot — nothing is configured yet — so it must not arm that dialog.
  const [searchQuery, setSearchQuery] = useState('')

  // The two observations above, resolved into the one thing the rest of the card
  // reads: none | seeking | picked (#893). Everything downstream — the rated
  // field, the summary, the submit payload — is a function of this.
  const selection = opponentSelection(opponent, searchQuery)

  const [bestOf, setBestOf] =
    useState<BestOfFieldProps['bestOf']>(DEFAULT_BEST_OF)
  // Default off so submitting without picking an opponent "just works" —
  // the no-opponent match is unrated by definition.
  const [rated, setRated] = useState(DEFAULT_RATED)
  const { submit, apiError, submitting, submitted, hasSucceeded } =
    useStartMatch()

  // Anything away from the form's defaults means the user has invested effort
  // that leaving would silently destroy (#75). An opponent the *URL* supplied is
  // not effort — arriving at a preseeded form and immediately backing out must
  // not pop the discard dialog — so the opponent arm keys off `pick`, the user's
  // own touch, rather than off the resolved `opponent`.
  const isDirty =
    pick !== undefined || bestOf !== DEFAULT_BEST_OF || rated !== DEFAULT_RATED

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

        {preselected.isResolving ? (
          // Hold the slot while the URL's opponent resolves, rather than
          // rendering the picker for a beat (which would flash the recent grid
          // and fire its fetch) only to replace it.
          <OpponentSkeleton />
        ) : opponent ? (
          <SelectedOpponent
            opponent={opponent}
            // Clearing the opponent must also clear `rated` — otherwise the
            // toggle's "off" appearance (because `effectiveRated` is gated by
            // `ratable`) hides a stored `true` that would either (a) trip the
            // rated-needs-opponent refinement with a disabled toggle the user
            // can't switch off, or (b) silently re-engage rating when a new
            // opponent is picked.
            //
            // It also clears the mirrored query: the picker unmounted when the
            // opponent was picked, so it comes back with an empty search box —
            // a stale mirror would leave the card in `seeking` while showing
            // the recent grid.
            onChange={() => {
              setPick(null)
              setRated(false)
              setSearchQuery('')
            }}
          />
        ) : (
          <OpponentPicker
            onPick={(player) => {
              setPick(opponentFromPlayer(player))
              setSearchQuery('')
            }}
            onQueryChange={setSearchQuery}
          />
        )}
      </div>

      <div className="nm-settings">
        <BestOfField bestOf={bestOf} setBestOf={setBestOf} />
        <RatedField
          rated={rated}
          setRated={setRated}
          // `seeking` is not an opponent, so the toggle stays unavailable while
          // the user is still hunting — same as `none`.
          opponent={selectedOpponent(selection)}
          isGuest={isGuest}
        />
      </div>

      <SubmitRow
        selection={selection}
        bestOf={bestOf}
        rated={rated}
        error={submitted ? apiError : null}
        submitting={submitting}
        onSubmit={() => submit({ selection, bestOf, rated })}
        onCancel={() => navigate({ to: '/dashboard' })}
      />

      <DiscardMatchSetupDialog
        open={blocker.status === 'blocked'}
        onLeave={() => blocker.proceed?.()}
        onStay={() => blocker.reset?.()}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Opponent placeholder                                              */
/* ------------------------------------------------------------------ */

/** Stand-in for the opponent slot while an `?opponent=` id from the URL is
 * being resolved. Same skeleton chrome the recent-opponents grid uses. */
function OpponentSkeleton() {
  return (
    <div className="nm-chip-skel" role="status" aria-label="Loading opponent">
      <div className="av" aria-hidden="true" />
      <div className="lines" aria-hidden="true">
        <div className="line" />
        <div className="line short" />
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Submit row                                                        */
/* ------------------------------------------------------------------ */

/**
 * The summary's headline. Each arm of the selection gets its own sentence —
 * in particular `seeking`, which used to be indistinguishable from `none` and
 * so was told "Ready: You · solo match" while the user was still searching
 * (#893). It is not ready, and saying so is the whole fix.
 */
function summaryHeadline(selection: OpponentSelection) {
  switch (selection.kind) {
    case 'picked':
      return (
        <>
          Ready: <b>You</b> vs <b>{selection.opponent.name}</b>
        </>
      )
    case 'seeking':
      return (
        <span className="opp-tbd">
          No opponent selected · this will be a solo match
        </span>
      )
    case 'none':
      return (
        <>
          Ready: <b>You</b> <span className="opp-tbd">· solo match</span>
        </>
      )
  }
}

function SubmitRow({
  selection,
  bestOf,
  rated,
  error,
  submitting,
  onSubmit,
  onCancel,
}: {
  selection: OpponentSelection
  bestOf: number
  rated: boolean
  error: string | null
  submitting: boolean
  onSubmit: () => void
  onCancel: () => void
}) {
  const opponent = selectedOpponent(selection)
  const effectivelyRated = rated && opponent !== null
  const gamesToWin = Math.ceil(bestOf / 2)
  const lengthCopy =
    bestOf === 1 ? 'Single game' : `Best of ${bestOf} · first to ${gamesToWin}`
  // Honesty, not a lock: the button stays enabled (house rule — never gate
  // submit on validity), but while the user is mid-search it says exactly what
  // pressing it would do. Starting a solo match is a legitimate choice; being
  // walked into one is not.
  const startLabel =
    selection.kind === 'seeking' ? 'Start solo match' : 'Start match'

  return (
    <div className="nm-summary">
      <div className="read">
        <div className="top">{summaryHeadline(selection)}</div>
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
          aria-busy={submitting}
        >
          {submitting && (
            <Loader2 className="fmm-icon-spin" size={16} strokeWidth={2.5} />
          )}
          {submitting ? 'Starting…' : startLabel}
          {!submitting && <ArrowRight size={16} strokeWidth={2.5} />}
        </button>
      </div>
    </div>
  )
}
