import { useMutation, useSuspenseQuery } from '@tanstack/react-query'
import { Link, useLocation, useNavigate, useParams, useRouteContext } from '@tanstack/react-router'
import type { FormEvent } from 'react'
import { classifyFailure, failureMessages, NoSigningKey } from '../../api/errors'
import { sessionQuery } from '../../api/queries'
import { Button } from '../../components/Button'
import { ErrorScreen } from '../../components/ErrorScreen'
import { Icon } from '../../components/Icon'
import { Wordmark } from '../../components/Wordmark'
import { checkGame, otherSide, tally, type Side } from '../../scoring/board'
import { useScratchpad } from '../../scoring/scratchpad'
import { Malformed } from '../../signing/cbor'
import { appendSignature, decodeEnvelope } from '../../signing/envelope'
import { signWithDeviceKey } from '../../signing/deviceKey'
import { decodePayload, type MatchResult } from '../../signing/result'
import { base64url, fromBase64url } from '../../signing/text'
import { gamesWon, PATH, sidesFor } from '../scoring/sides'
import '../scoring/scoring.css'

const ROUTE = '/_authenticated/matches/$matchId/scores/approvals/new'

// A result link's envelope, decoded. `mySide` is the side the viewer
// stands in as: the one that hasn't signed, or once both have, the last
// one to sign, which approving on this page makes the viewer's.
type Opened = {
  envelope: Uint8Array<ArrayBuffer>
  issuedAt: number
  result: MatchResult
  mySide: Side
  approved: boolean
}

type Outcome = { winner: Side; won: [number, number]; retired: Side | null }

// The page a result link opens, where the other player approves the result
// with their signature, or goes back to edit the scores. Until matches come
// from the API, every viewer stands in as the player who hasn't signed. It
// shows only what the link's payload, the session and this device's
// scratchpad say. The payload names players by id alone, so a row shows a
// username only if this device already has that player's name.
export function AcceptResult() {
  const { hash } = useLocation()
  const opened = open(hash)
  if (!opened) {
    return (
      <ErrorScreen
        title="This link isn’t a FortyMM result"
        actions={
          <Link to="/" className="fm-btn fm-btn--primary">
            Go to FortyMM
          </Link>
        }
      >
        Its result is missing or damaged. Ask for the link again.
      </ErrorScreen>
    )
  }
  return <Result opened={opened} />
}

function Result({ opened }: { opened: Opened }) {
  const { matchId } = useParams({ from: ROUTE })
  const { api } = useRouteContext({ from: '__root__' })
  const { data: account } = useSuspenseQuery(sessionQuery(api))
  const pad = useScratchpad(matchId)
  const { result, issuedAt, mySide, approved } = opened

  // The names this device already has, by player id. Nothing is fetched.
  const known = new Map(Object.values(pad.games).map(({ savedBy }) => [savedBy.playerId, savedBy.name]))
  known.set(account.player.id, account.player.display_name)
  const usernameOf = (side: Side) => known.get(result.players[side])
  const roleOf = (side: Side) => (side === mySide ? 'You' : 'Your opponent')

  const outcome = outcomeOf(result)
  const order = sidesFor(mySide)
  const reportedAt = new Date(issuedAt * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  const wonOrLost = outcome.winner === mySide ? 'won' : 'lost'
  const score =
    outcome.retired === null
      ? `you ${wonOrLost} ${gamesWon(outcome.won, outcome.winner)}`
      : `${outcome.retired === mySide ? 'you' : 'they'} retired, so you ${wonOrLost}`

  return (
    <div className="score-page">
      <header className="score-top">
        <Wordmark />
        <Link to="/" className="fm-btn fm-btn--ghost fm-btn--sm">
          <Icon name="back" />
          Home
        </Link>
      </header>
      <main className="score-content approval">
        <div className="approval-hero">
          <h1 className="approval-title">Review match score</h1>
          <p className="approval-lede">
            {approved ? `You approved that ${score}.` : `Your opponent reported that ${score}. Do these scores look right?`}
          </p>
          {approved && (
            <p className="fm-notice approval-status" role="status">
              <Icon name="check" />
              <span>Approved on this device</span>
            </p>
          )}
        </div>
        <section className="fm-card approval-card" aria-label="Result">
          <div className="approval-games">
            <table className="fm-games">
              <caption className="fm-sr">Game scores</caption>
              <thead>
                <tr>
                  <th scope="col">
                    <span className="fm-sr">Player</span>
                  </th>
                  {result.games.map((_, game) => (
                    <th key={game} scope="col">
                      <span aria-hidden="true">{game + 1}</span>
                      <span className="fm-sr">Game {game + 1}</span>
                    </th>
                  ))}
                  <th scope="col" className="approval-total">
                    Won
                  </th>
                </tr>
              </thead>
              <tbody>
                {order.map((side) => (
                  <tr key={side} className={side === outcome.winner ? 'approval-winner' : undefined}>
                    <th scope="row">
                      <span className="approval-role">{roleOf(side)}</span>
                      {usernameOf(side) && (
                        <span className="approval-username">
                          <span aria-hidden="true"> · </span>
                          {usernameOf(side)}
                        </span>
                      )}
                      {side === outcome.retired && <small>Retired</small>}
                    </th>
                    {result.games.map((points, game) => (
                      <td key={game} className={wonGame(points, side) ? 'w' : undefined}>
                        {points[side]}
                      </td>
                    ))}
                    <td className="approval-total">{outcome.won[side]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="approval-facts">
            Best of {result.bestOf} · {result.rated ? 'Rated' : 'Unrated'} · Reported {reportedAt}
            {result.replaces && ' · Corrects an earlier result'}
          </p>
        </section>
        {!approved && <ApproveForm envelope={opened.envelope} side={mySide} matchId={matchId} />}
      </main>
    </div>
  )
}

// Approve signs the link's payload for the viewer's side, then puts the
// result with both signatures in the URL, so a reload shows it approved.
// It all happens on this device. The page never says "sign": to a player,
// signing is approving. Edit scores goes back to the match's scores.
function ApproveForm({ envelope, side, matchId }: { envelope: Uint8Array<ArrayBuffer>; side: Side; matchId: string }) {
  const navigate = useNavigate()
  const submit = useMutation({
    networkMode: 'always',
    mutationFn: async () => {
      const signer = await signWithDeviceKey()
      if (!signer) throw new NoSigningKey()
      return appendSignature(signer, envelope, side)
    },
    onSuccess: (signed) => navigate({ to: '.', hash: base64url(signed), replace: true }),
  })
  const failure = submit.error && failureMessages[classifyFailure(submit.error).kind]

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (!submit.isPending) submit.mutate()
  }

  return (
    <form className="approval-form" aria-label="Approve the result" onSubmit={onSubmit}>
      {failure && (
        <div className="fm-alert fm-alert--error" role="alert">
          <Icon name="error" />
          <p className="fm-alert__title">{failure.title}</p>
          <p className="fm-alert__body">{failure.sentence}</p>
        </div>
      )}
      <div className="approval-actions">
        <Button type="submit" variant="primary" size="lg" busy={submit.isPending}>
          {submit.isPending ? 'Approving…' : 'Approve result'}
        </Button>
        <Link to={PATH} params={{ matchId, gameNumber: '1' }} className="fm-btn fm-btn--secondary fm-btn--lg">
          Edit scores
        </Link>
      </div>
    </form>
  )
}

function wonGame(points: [number, number], side: Side): boolean {
  const game = checkGame(points)
  return game.kind === 'legal' && game.winner === side
}

// Who won, by how many games, and who retired. A retirement can leave the
// last game unfinished, so only finished games count.
function outcomeOf(result: MatchResult): Outcome {
  const won = tally(result.games.filter((points) => checkGame(points).kind === 'legal'))
  if (result.ending === 'retired') {
    return { winner: otherSide(result.retiredBy), won, retired: result.retiredBy }
  }
  return { winner: won[0] > won[1] ? 0 : 1, won, retired: null }
}

// The link's fragment as a result, or null for anything that isn't one.
function open(fragment: string): Opened | null {
  try {
    const envelope = fromBase64url(fragment)
    const { payload, signatures } = decodeEnvelope(envelope)
    const signed = new Set(signatures.map(({ side }) => side))
    const unsigned = ([0, 1] as const).find((side) => !signed.has(side))
    return {
      envelope,
      ...decodePayload(payload),
      mySide: unsigned ?? signatures[signatures.length - 1].side,
      approved: unsigned === undefined,
    }
  } catch (error) {
    if (error instanceof Malformed) return null
    throw error
  }
}
