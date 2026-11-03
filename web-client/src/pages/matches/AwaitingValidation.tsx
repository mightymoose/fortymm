import { useSuspenseQuery } from '@tanstack/react-query'
import { Link, Navigate, useLoaderData } from '@tanstack/react-router'
import { Button } from '../../components/Button'
import { Icon } from '../../components/Icon'
import { QrCode } from '../../components/QrCode'
import { QueryBoundary } from '../../components/QueryBoundary'
import { useToast } from '../../components/toastContext'
import { Wordmark } from '../../components/Wordmark'
import { matchWinner, otherSide, tally } from '../../scoring/board'
import type { Match } from '../../scoring/demoMatches'
import { useScratchpad, type Submitted } from '../../scoring/scratchpad'
import { signedResultOf, signedResultQuery } from '../../scoring/signedResult'
import { base64url, qrText } from '../../signing/text'
import { gamesWon, PATH, shown, sidesFor } from '../scoring/sides'
import '../scoring/scoring.css'

const ROUTE = '/_authenticated/matches/$matchId/validation'

// Where a player lands after submitting a result. The other player confirms
// it from the QR code or the link, which carry the result this device
// signed. A pad that isn't this player's submission goes back to the scores.
export function AwaitingValidation() {
  const { match, me } = useLoaderData({ from: ROUTE })
  const { submission } = useScratchpad(match.id)
  if (submission.phase !== 'submitted' || submission.by !== me) {
    return <Navigate to={PATH} params={{ matchId: match.id, gameNumber: '1' }} replace />
  }
  const { side } = signedResultOf(match, submission)
  const other = match.players[otherSide(side)]
  const winner = matchWinner(submission.games)
  const sides = sidesFor(side)

  return (
    <div className="score-page">
      <header className="score-top">
        <Wordmark />
        <Link to="/" className="fm-btn fm-btn--ghost fm-btn--sm">
          <Icon name="back" />
          Home
        </Link>
      </header>
      <main className="score-content">
        <h1 className="score-title">Waiting for validation</h1>
        <p className="fm-notice">
          <Icon name="info" />
          <span>
            <b>{other.name}</b> confirms the result by scanning this code or opening the link.
          </span>
        </p>
        <section className="validation-summary" aria-label="Result">
          <p>
            <b>{match.players[winner].name}</b> wins {gamesWon(tally(submission.games), winner)}
          </p>
          <ol className="validation-games">
            {submission.games.map((points, index) => (
              <li key={index}>
                Game {index + 1} <span className="num">{shown(points, sides)}</span>
              </li>
            ))}
          </ol>
        </section>
        <QueryBoundary skeleton={<SignedResultSkeleton />}>
          <SignedResult match={match} submission={submission} />
        </QueryBoundary>
        <Link
          to={PATH}
          params={{ matchId: match.id, gameNumber: '1' }}
          className="fm-btn fm-btn--secondary validation-back"
        >
          Back to the scores
        </Link>
      </main>
    </div>
  )
}

function SignedResult({ match, submission }: { match: Match; submission: Submitted }) {
  const { data: envelope } = useSuspenseQuery(signedResultQuery(match, submission))
  const showToast = useToast()
  // Same-origin, so it opens on a Preview and in dev as it does on fortymm.com.
  const path = `/r#${base64url(envelope)}`
  const url = new URL(path, window.location.origin).href
  return (
    <section className="validation-share" aria-label="Signed result">
      <QrCode text={qrText(envelope)} label="QR code of the signed result" />
      <a className="validation-link num" href={path}>
        {url}
      </a>
      <Button
        variant="secondary"
        size="sm"
        onClick={() =>
          navigator.clipboard.writeText(url).then(
            () => showToast('Link copied', { icon: 'check' }),
            () => showToast('This browser didn’t let FortyMM copy the link', { icon: 'info' }),
          )
        }
      >
        Copy link
      </Button>
    </section>
  )
}

function SignedResultSkeleton() {
  return (
    <div className="validation-share" aria-busy="true">
      <div className="fm-skeleton qr-code" />
      <div className="fm-skeleton validation-link-skeleton" />
    </div>
  )
}
