import { useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
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
import { pageTitle } from '@/lib/page-title'
import './new.css'

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
  const [bestOf, setBestOf] = useState<BestOfFieldProps['bestOf']>(5)
  // Default off so submitting without picking an opponent "just works" —
  // the no-opponent match is unrated by definition.
  const [rated, setRated] = useState(false)
  const { submit, apiError, sessionExpired, submitting, submitted } =
    useStartMatch()

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
        sessionExpired={sessionExpired}
        submitting={submitting}
        onSubmit={() => submit({ opponent, bestOf, rated })}
        onSignIn={() =>
          navigate({ to: '/login', search: { email: undefined, error: undefined } })
        }
        onCancel={() => navigate({ to: '/dashboard' })}
      />
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
  sessionExpired,
  submitting,
  onSubmit,
  onSignIn,
  onCancel,
}: {
  opponent: Opponent | null
  bestOf: number
  rated: boolean
  error: string | null
  sessionExpired: boolean
  submitting: boolean
  onSubmit: () => void
  onSignIn: () => void
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
        {error &&
          (sessionExpired ? (
            <div className="nm-recovery" role="alert">
              <p className="nm-error">{error}</p>
              <button
                type="button"
                className="nm-btn nm-btn-primary nm-recovery-btn"
                onClick={onSignIn}
              >
                Sign in again
              </button>
            </div>
          ) : (
            <p className="nm-error" role="alert">
              {error}
            </p>
          ))}
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
          className={`nm-btn nm-btn-primary${submitting ? ' cursor-wait' : ''}`}
          onClick={onSubmit}
          disabled={submitting}
        >
          {submitting ? (
            <Loader2 size={16} strokeWidth={2.5} className="animate-spin" />
          ) : null}
          {submitting ? 'Starting…' : 'Start match'}
          {!submitting && <ArrowRight size={16} strokeWidth={2.5} />}
        </button>
      </div>
    </div>
  )
}
