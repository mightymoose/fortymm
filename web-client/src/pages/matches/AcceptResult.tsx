import { useMutation, useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { Link, useLoaderData, useLocation, useNavigate, useParams, useRouteContext } from '@tanstack/react-router'
import { useRef, type FormEvent, type ReactNode } from 'react'
import { classifyFailure, failureMessages, NoSigningKey } from '../../api/errors'
import { can, Permission } from '../../api/permissions'
import { matchQuery, sessionQuery } from '../../api/queries'
import { Button } from '../../components/Button'
import { ErrorScreen } from '../../components/ErrorScreen'
import { Icon } from '../../components/Icon'
import { Wordmark } from '../../components/Wordmark'
import { approvalFor, type Approval } from '../../scoring/approval'
import { checkGame, tally, type Side } from '../../scoring/board'
import { demoPlayerName, type Match } from '../../scoring/demoMatches'
import type { Fragment } from '../../scoring/fragment'
import { queueResult } from '../../scoring/results'
import { appendSignature } from '../../signing/envelope'
import { signWithDeviceKey } from '../../signing/deviceKey'
import type { MatchResult } from '../../signing/result'
import { base64url } from '../../signing/text'
import { yourSide, type MatchDetail } from './browse/match'
import { gamesWon, PATH, sidesFor } from '../scoring/sides'
import { signInHref } from '../useSignInHref'
import { ServerCheck } from './ServerCheck'
import '../scoring/scoring.css'

const ROUTE = '/_authenticated/matches/$matchId/scores/approvals/new'

type Signed = Extract<Fragment, { kind: 'signed' }>
type Account = { kind: 'guest' | 'verified'; player: { id: string; display_name: string } }

// The page a result link opens. It works out who is looking from the
// link and the session alone, so it works offline: only the player whose
// side hasn't approved may approve, and anyone else sees the result read
// only. A link opens only a result the scores page could edit, so one rule
// decides what a result link may hold, and only one whose signatures hold.
export function AcceptResult() {
  const { pathname, hash } = useLocation()
  const { matchId } = useParams({ from: ROUTE })
  const { api } = useRouteContext({ from: '__root__' })
  const { data: account } = useSuspenseQuery(sessionQuery(api))
  const { fragment, holds, match, syncs } = useLoaderData({ from: ROUTE })
  // Approving never waits on the network, so the match doesn't suspend the
  // page. Until FortyMM answers, or offline, the page names only the
  // players this device knows and offers Edit scores.
  const { data: read } = useQuery({
    ...matchQuery(api, match.id),
    enabled: match.source === 'api' && can(account, Permission.matchesView),
  })
  if (!fragment) {
    return (
      <LinkError title="This link isn’t a FortyMM result">
        Its result is missing or damaged. Ask for the link again.
      </LinkError>
    )
  }
  if (!holds) {
    return (
      <LinkError title="This link has been changed and can’t be trusted">
        Its scores don’t match the ones your opponent sent. Ask them for the link again.
      </LinkError>
    )
  }
  const approval = approvalFor({
    signers: fragment.signers,
    players: [match.players[0].id, match.players[1].id],
    account: { kind: account.kind, playerId: account.player.id },
    sync: syncs ? 'here' : match.source === 'api' ? 'elsewhere' : 'nowhere',
    final: read?.status.kind === 'final',
    serverSide: read ? yourSide(read) : undefined,
  })
  return (
    <Result
      fragment={fragment}
      approval={approval}
      names={namesOf(match, account, read)}
      final={read?.status.kind === 'final'}
      hash={hash}
      signIn={signInHref(`${pathname}#${hash}`)}
      matchId={matchId}
      syncs={syncs}
    />
  )
}

function LinkError({ title, children }: { title: string; children: string }) {
  return (
    <ErrorScreen
      title={title}
      actions={
        <Link to="/" className="fm-btn fm-btn--primary">
          Go to FortyMM
        </Link>
      }
    >
      {children}
    </ErrorScreen>
  )
}

// Each side's player's name, or null where this device knows none: from
// FortyMM's read of the match, the session's own player, or a demo
// match's made-up players.
function namesOf(match: Match, account: Account, read: MatchDetail | null | undefined): [string | null, string | null] {
  const nameOf = (side: Side) => {
    if (read) return read.players[side].name
    const { id } = match.players[side]
    if (id === account.player.id) return account.player.display_name
    return match.source === 'demo' ? demoPlayerName(id) : null
  }
  return [nameOf(0), nameOf(1)]
}

function Result({
  fragment,
  approval,
  names,
  final,
  hash,
  signIn,
  matchId,
  syncs,
}: {
  fragment: Signed
  approval: Approval
  names: [string | null, string | null]
  final: boolean
  hash: string
  // Signs in and comes back to this link, with its result.
  signIn: string
  matchId: string
  syncs: boolean
}) {
  const { result, issuedAt } = fragment
  const mySide = 'side' in approval ? approval.side : null
  const opponent = mySide === null ? null : names[mySide === 0 ? 1 : 0]
  const rowOf = (side: Side): { role: string; username: string | null } => {
    if (mySide === null) return { role: names[side] ?? `Player ${side + 1}`, username: null }
    return { role: side === mySide ? 'You' : 'Your opponent', username: names[side] }
  }

  const outcome = outcomeOf(result)
  const order = sidesFor(mySide ?? 0)
  const reportedAt = new Date(issuedAt * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  const score = `${outcome.winner === mySide ? 'won' : 'lost'} ${gamesWon(outcome.won, outcome.winner)}`
  const editScores = !final && mySide !== null && <EditScores matchId={matchId} hash={hash} />

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
          <p className="approval-lede">{ledeOf(approval, score, opponent)}</p>
          {approval.kind === 'waiting' && (
            <p className="fm-notice" role="status">
              <Icon name="clock" />
              <span>Waiting for {opponent ?? 'your opponent'} to approve</span>
            </p>
          )}
          {approval.kind === 'send' && (
            <ServerCheck matchId={result.match} envelope={fragment.envelope} approvedHere={approval.approvedHere} />
          )}
          {approval.kind === 'approved-here' && (
            <>
              <p className="fm-notice approval-status" role="status">
                <Icon name="check" />
                <span>Approved on this device</span>
              </p>
              {approval.handBack && (
                <p className="approval-lede">
                  Send this link back to {opponent ?? 'your opponent'}, so their phone sends it to FortyMM.
                </p>
              )}
            </>
          )}
          {approval.kind === 'approved' && (
            <p className="fm-notice approval-status" role="status">
              <Icon name="check" />
              <span>Approved by both players</span>
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
                {order.map((side) => {
                  const { role, username } = rowOf(side)
                  return (
                    <tr key={side} className={side === outcome.winner ? 'approval-winner' : undefined}>
                      <th scope="row">
                        <span className="approval-role">{role}</span>
                        {username && (
                          <span className="approval-username">
                            <span aria-hidden="true"> · </span>
                            {username}
                          </span>
                        )}
                      </th>
                      {result.games.map((points, game) => (
                        <td key={game} className={wonGame(points, side) ? 'w' : undefined}>
                          {points[side]}
                        </td>
                      ))}
                      <td className="approval-total">{outcome.won[side]}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className="approval-facts">
            Best of {result.bestOf} · {result.rated ? 'Rated' : 'Unrated'} · Reported {reportedAt}
            {result.replaces && ' · Replaces the scores sent before'}
          </p>
        </section>
        {approval.kind === 'approve' ? (
          <ApproveForm envelope={fragment.envelope} side={approval.side} matchId={matchId} hash={hash} syncs={syncs}>
            {editScores}
          </ApproveForm>
        ) : approval.kind === 'sign-in' ? (
          <div className="approval-actions">
            <a href={signIn} className="fm-btn fm-btn--primary fm-btn--lg">
              Sign in
            </a>
          </div>
        ) : (
          editScores && <div className="approval-actions">{editScores}</div>
        )}
      </main>
    </div>
  )
}

function ledeOf(approval: Approval, score: string, opponent: string | null): string {
  switch (approval.kind) {
    case 'approve':
      return `${opponent ?? 'Your opponent'} reported that you ${score}. Do these scores look right?`
    case 'waiting':
      return `You reported that you ${score}.`
    case 'send':
    case 'approved-here':
    case 'approved':
      return `You ${score}.`
    case 'final':
      return 'This match is final, so there’s nothing left to approve.'
    case 'not-yours':
      return 'This isn’t your match, so you can’t approve it.'
    case 'sign-in':
      return 'This result is for another player. If it’s your match, sign in to approve it.'
  }
}

// Approve signs the link's payload for the viewer's side, then puts the
// result with both signatures in the URL, so a reload shows it approved.
// The approval happens on this device, so it works with no network. If
// this device sends the match's results, the approved page sends the result
// to FortyMM to check. The page never says "sign": to a player, signing is
// approving.
//
// Only Approve queues anything: opening a link sends nothing, or a link
// could commit scores with the viewer's session before they review them.
// The link's result, then the approved one, go after anything this device
// queued before, so a counter built on a result that hasn't reached the
// server yet lands after it, not before it.
function ApproveForm({
  envelope,
  side,
  matchId,
  hash,
  syncs,
  children,
}: {
  envelope: Uint8Array<ArrayBuffer>
  side: Side
  matchId: string
  hash: string
  syncs: boolean
  children: ReactNode
}) {
  const navigate = useNavigate()
  // A second tap can land before React renders the first as pending, and
  // each tap would sign and send its own approval.
  const approving = useRef(false)
  const submit = useMutation({
    networkMode: 'always',
    mutationFn: async () => {
      const signer = await signWithDeviceKey()
      if (!signer) throw new NoSigningKey()
      return appendSignature(signer, envelope, side)
    },
    onSuccess: (signed) => {
      const approved = base64url(signed)
      if (syncs) {
        queueResult(matchId, hash)
        queueResult(matchId, approved)
      }
      return navigate({ to: '.', hash: approved, replace: true })
    },
    onError: () => {
      approving.current = false
    },
  })
  const failure = submit.error && failureMessages[classifyFailure(submit.error).kind]

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (approving.current) return
    approving.current = true
    submit.mutate()
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
        {children}
      </div>
    </form>
  )
}

// Opens the match's scores with the result on this page, unchanged, so an
// edit corrects it.
function EditScores({ matchId, hash }: { matchId: string; hash: string }) {
  return (
    <Link to={PATH} params={{ matchId, gameNumber: '1' }} hash={hash} className="fm-btn fm-btn--secondary fm-btn--lg">
      Edit scores
    </Link>
  )
}

function wonGame(points: [number, number], side: Side): boolean {
  const game = checkGame(points)
  return game.kind === 'legal' && game.winner === side
}

// Who won, and by how many games.
function outcomeOf(result: MatchResult): { winner: Side; won: [number, number] } {
  const won = tally(result.games)
  return { winner: won[0] > won[1] ? 0 : 1, won }
}
