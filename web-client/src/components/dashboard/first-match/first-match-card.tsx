import { useState } from 'react'
import { ArrowRight } from 'lucide-react'

import { deriveEmailStatus, useSession } from '@/api/session'
import { OpponentPicker } from '@/components/matches/opponent-picker'
import { BestOfField } from '@/components/matches/match-setup/best-of-field'
import { RatedField } from '@/components/matches/match-setup/rated-field'
import { SelectedOpponent } from '@/components/matches/match-setup/selected-opponent'
import {
  opponentFromPlayer,
  type Opponent,
} from '@/components/matches/match-setup/opponent'
import { useStartMatch } from '@/components/matches/match-setup/use-start-match'
import { Card } from '@/components/dashboard/your-game-row/card'
import { C, MONO, UI } from '@/components/dashboard/dashboard-tokens'
import { Overline } from '@/components/overline'
import '@/components/matches/match-setup/match-setup.css'

/**
 * The zero-match dashboard's hero: pick an opponent, set the format, start
 * scoring. Requires an opponent (unlike `/matches/new`, which also supports a
 * solo match) — solo sessions stay reachable via the page-header "Log a
 * match" link. Reuses the same match-setup building blocks and submit
 * machinery as `/matches/new`, so this is a self-fetching, stateful widget
 * like that page's `MatchCard`, not a pure props-in view — hence no
 * `.page.tsx`/`.factory.tsx` pair (see `dashboard-page.tsx` for the same
 * pattern at the page level).
 */
export const FirstMatchCard = () => {
  const { data: session } = useSession()
  const [opponent, setOpponent] = useState<Opponent | null>(null)
  const [bestOf, setBestOf] = useState(5)
  // Unlike /matches/new (defaults off so a blank solo submit "just works"),
  // this hero requires an opponent before it is even submittable, so rated
  // defaults on the moment one is picked — matching the mock.
  const [rated, setRated] = useState(true)
  const { submit, apiError, submitting, submitted } = useStartMatch()

  const me = session?.data.user ?? null
  const isGuest =
    me != null &&
    deriveEmailStatus({
      email: me.email ?? null,
      confirmedAt: me.confirmed_at ?? null,
      pendingEmail: me.pending_email ?? null,
    }) === 'guest'

  const gamesToWin = Math.ceil(bestOf / 2)
  const effectivelyRated = rated && opponent !== null
  const summary = `Best of ${bestOf} · first to ${gamesToWin} · ${
    effectivelyRated ? 'rated' : 'unrated'
  }`

  function handlePick(player: Parameters<typeof opponentFromPlayer>[0]) {
    setOpponent(opponentFromPlayer(player))
    setRated(true)
  }

  const error = submitted ? apiError : null

  return (
    <Card style={{ minWidth: 0, overflow: 'visible' }}>
      <Overline style={{ color: C.ball400 }}>Your next match</Overline>
      <h2
        style={{
          margin: '8px 0 6px',
          font: `700 22px ${UI}`,
          letterSpacing: '-0.01em',
          color: C.chalk50,
        }}
      >
        Log your first match
        <span style={{ color: C.ball500 }}>.</span>
      </h2>
      <p
        style={{
          margin: '0 0 20px',
          font: `400 13px ${UI}`,
          lineHeight: 1.5,
          color: C.chalk300,
        }}
      >
        Pick who you played, set the format, and start scoring — your rating
        kicks in the moment you finish.
      </p>

      <div className="nm-section-head" style={{ marginBottom: 10 }}>
        <span className="title">Who did you play?</span>
      </div>

      {opponent ? (
        <SelectedOpponent
          opponent={opponent}
          // `rated` is unobservable while opponent is null (RatedField,
          // the summary line, and the submit button are all gated on
          // opponent !== null), and the next pick's handlePick always
          // resets it to true anyway — no need to touch it here too.
          onChange={() => setOpponent(null)}
        />
      ) : (
        <OpponentPicker defaultToSearch onPick={handlePick} />
      )}

      {opponent && (
        <div className="nm-fm-settings" style={{ marginTop: 18 }}>
          <BestOfField bestOf={bestOf} setBestOf={setBestOf} />
          <RatedField
            rated={rated}
            setRated={setRated}
            opponent={opponent}
            isGuest={isGuest}
          />
        </div>
      )}

      <div style={{ marginTop: 20 }}>
        {opponent && (
          <div
            style={{
              marginBottom: 10,
              font: `500 12px ${MONO}`,
              letterSpacing: '0.02em',
              color: C.chalk300,
            }}
          >
            {summary}
          </div>
        )}
        {error && (
          <p className="nm-error" role="alert">
            {error}
          </p>
        )}
        <button
          type="button"
          className="nm-btn nm-btn-primary"
          disabled={!opponent || submitting}
          aria-busy={submitting}
          onClick={() => submit({ opponent, bestOf, rated })}
        >
          {submitting ? 'Starting…' : 'Start scoring'}
          {!submitting && <ArrowRight size={16} strokeWidth={2.5} />}
        </button>
        {!opponent && (
          <p
            style={{
              margin: '10px 0 0',
              font: `400 12px ${UI}`,
              color: C.chalk300,
            }}
          >
            Pick who you played to set the match format.
          </p>
        )}
      </div>
    </Card>
  )
}
