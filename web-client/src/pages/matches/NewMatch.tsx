import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { Link, useNavigate, useRouteContext } from '@tanstack/react-router'
import { useEffect, useId, useReducer, useRef } from 'react'
import { ApiError, ApiUnreachable, classifyFailure, failureMessages } from '../../api/errors'
import { createMatch, matchQuery, OPPONENTS_KEY, sessionQuery } from '../../api/queries'
import { uuidv7 } from '../../api/uuidv7'
import { Button } from '../../components/Button'
import { Icon } from '../../components/Icon'
import { PlayerAvatar } from '../../components/PlayerAvatar'
import { keyTarget } from '../../components/singleSelect'
import type { BestOf } from '../../scoring/board'
import { draftHash, nowSeconds } from '../../scoring/fragment'
import { apiMatch } from '../../scoring/matches'
import { OpponentPicker } from './newMatch/OpponentPicker'
import {
  BEST_OF_OPTIONS,
  initialSetup,
  lengthHelp,
  setupReducer,
  summaryLine,
  type Setup,
  type SetupAction,
} from './newMatch/setup'
import './newMatch/newMatch.css'

// Sets up a match against another player, then opens its scores. Start
// match is never off: without an opponent it says to pick one and sends
// nothing.
export function NewMatch() {
  const { api } = useRouteContext({ from: '__root__' })
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { data: account } = useSuspenseQuery(sessionQuery(api))
  const [setup, dispatch] = useReducer(setupReducer, initialSetup)
  // A second press before React renders again would see the first press's
  // state and send another match.
  const sending = useRef(false)
  // A create that answers after the person left the page opens nothing.
  const left = useRef(false)
  useEffect(() => {
    left.current = false
    return () => {
      left.current = true
    }
  }, [])
  const opponentErrorId = useId()

  async function start() {
    if (sending.current) return
    const action: SetupAction = { type: 'start', self: account.player.id, freshId: uuidv7() }
    const next = setupReducer(setup, action)
    dispatch(action)
    if (next.submit.kind !== 'starting' || !next.attempt) return
    const request = next.attempt
    const { id } = request
    const [first, second] = request.players
    // The attempt keeps its id, so the press after the connection is back
    // sends the same match.
    if (!navigator.onLine) {
      dispatch({ type: 'offline' })
      return
    }
    sending.current = true
    try {
      await createMatch(api, request)
      void queryClient.invalidateQueries({ queryKey: OPPONENTS_KEY })
      if (left.current) return
      // Back from game 1 then opens the match, not this form, whose Start
      // would make a second match.
      await navigate({ to: '/matches/$matchId', params: { matchId: id }, replace: true })
      // The fragment carries the match, so its scores open with no network.
      await navigate({
        to: '/matches/$matchId/scores/game/$gameNumber/edit',
        params: { matchId: id, gameNumber: '1' },
        hash: draftHash(apiMatch(id, request.best_of, request.rated, [first, second]), [], null, nowSeconds()),
      })
      // The match page's loader read the match before it had a board. Kept,
      // that read would show first when the match page opens again, and its
      // Keep score would drop the games saved since.
      queryClient.removeQueries({ queryKey: matchQuery(api, id).queryKey })
    } catch (error) {
      if (error instanceof ApiError && error.status === 422 && error.title) {
        // A player may have merged since the list loaded.
        void queryClient.invalidateQueries({ queryKey: OPPONENTS_KEY })
        dispatch({ type: 'refused', title: error.title })
      } else if (error instanceof ApiUnreachable) {
        dispatch({ type: 'offline' })
      } else {
        dispatch({ type: 'failed', failure: classifyFailure(error) })
      }
    } finally {
      sending.current = false
    }
  }

  return (
    <div className="new-match">
      <h1>New match</h1>
      <section className="fm-card new-match__card" aria-label="Match setup">
        <div className="new-match__you">
          <PlayerAvatar name={account.player.display_name} />
          <span className="new-match__who">
            <span className="new-match__sub">You</span>
            <span className="new-match__name">{account.player.display_name}</span>
          </span>
        </div>
        <div className="new-match__opponent">
          <h2 className="new-match__heading">Opponent</h2>
          <OpponentPicker
            choice={setup.opponent}
            onPick={(opponent) => dispatch({ type: 'pick', opponent })}
            onClear={() => dispatch({ type: 'clearOpponent' })}
          />
          {setup.submit.kind === 'needsOpponent' && (
            <p className="fm-error" role="alert" id={opponentErrorId}>
              <Icon name="error" />
              Pick an opponent to start the match.
            </p>
          )}
        </div>
        <div className="new-match__settings">
          <BestOfField bestOf={setup.bestOf} onChange={(bestOf) => dispatch({ type: 'bestOf', bestOf })} />
          <RatedField setup={setup} onChange={(rated) => dispatch({ type: 'rated', rated })} />
        </div>
        <div className="new-match__summary">
          <div className="new-match__read">
            <p className="new-match__headline">
              {setup.opponent.kind === 'picked' ? (
                <>
                  Ready: <b>You</b> vs <b>{setup.opponent.opponent.name}</b>
                </>
              ) : (
                'Pick an opponent to start.'
              )}
            </p>
            <p className="fm-help">{summaryLine(setup)}</p>
            <StartError setup={setup} />
          </div>
          <div className="new-match__actions">
            <Link to="/" className="fm-btn fm-btn--ghost">
              Cancel
            </Link>
            <Button
              variant="primary"
              busy={setup.submit.kind === 'starting'}
              aria-disabled={setup.submit.kind === 'starting'}
              aria-describedby={setup.submit.kind === 'needsOpponent' ? opponentErrorId : undefined}
              onClick={() => void start()}
            >
              {setup.submit.kind === 'starting' ? 'Starting…' : 'Start match'}
            </Button>
          </div>
        </div>
      </section>
    </div>
  )
}

function StartError({ setup }: { setup: Setup }) {
  switch (setup.submit.kind) {
    case 'refused':
      return (
        <p className="fm-error" role="alert">
          <Icon name="error" />
          {setup.submit.title}
        </p>
      )
    case 'failed': {
      const { title, sentence } = failureMessages[setup.submit.failure.kind]
      return (
        <p className="fm-error" role="alert">
          <Icon name="error" />
          <span>
            {title}. {sentence}
          </span>
        </p>
      )
    }
    case 'offline':
      return (
        <p className="fm-error" role="alert">
          <Icon name="offline" />
          Making a match needs a connection. Connect, then press Start match again.
        </p>
      )
    default:
      return null
  }
}

// A radiogroup with one tab stop: the arrow keys, Home and End pick
// another length and move focus to it.
function BestOfField({ bestOf, onChange }: { bestOf: BestOf; onChange: (bestOf: BestOf) => void }) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const labelId = useId()
  const helpId = useId()
  return (
    <div className="fm-field">
      <span className="fm-label" id={labelId}>
        Match length
      </span>
      <div className="fm-seg new-match__length" role="radiogroup" aria-labelledby={labelId} aria-describedby={helpId}>
        {BEST_OF_OPTIONS.map((option, index) => (
          <button
            key={option.bestOf}
            ref={(button) => {
              buttons.current[index] = button
            }}
            type="button"
            role="radio"
            aria-checked={option.bestOf === bestOf}
            tabIndex={option.bestOf === bestOf ? 0 : -1}
            onClick={() => onChange(option.bestOf)}
            onKeyDown={(event) => {
              const next = keyTarget(event.key, index, BEST_OF_OPTIONS.length)
              if (next === null) return
              event.preventDefault()
              onChange(BEST_OF_OPTIONS[next].bestOf)
              buttons.current[next]?.focus()
            }}
          >
            <span className="num">{option.bestOf}</span> {option.label}
          </button>
        ))}
      </div>
      <p className="fm-help" id={helpId}>
        {lengthHelp(bestOf)}
      </p>
    </div>
  )
}

function RatedField({ setup, onChange }: { setup: Setup; onChange: (rated: boolean) => void }) {
  const helpId = useId()
  const picked = setup.opponent.kind === 'picked'
  const help = !picked
    ? 'Pick an opponent to make this rated.'
    : setup.rated
      ? 'The result changes both players’ ratings.'
      : 'No rating change. The match still goes in your history.'
  return (
    <div className="fm-field">
      <button
        type="button"
        className="fm-switch"
        role="switch"
        aria-checked={setup.rated}
        aria-describedby={helpId}
        disabled={!picked}
        onClick={() => onChange(!setup.rated)}
      >
        <span className="fm-switch__track"></span>
        Rated match
      </button>
      <p className="fm-help" id={helpId}>
        {help}
      </p>
    </div>
  )
}
