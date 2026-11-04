import { useSuspenseQuery } from '@tanstack/react-query'
import { Link, useLoaderData, useLocation, useParams, useRouteContext, useRouter } from '@tanstack/react-router'
import { Button } from '../../components/Button'
import { ErrorScreen } from '../../components/ErrorScreen'
import { Icon } from '../../components/Icon'
import { QrCode } from '../../components/QrCode'
import { useToast } from '../../components/toastContext'
import { Wordmark } from '../../components/Wordmark'
import { matchWinner, otherSide, tally } from '../../scoring/board'
import { matchOf } from '../../scoring/matches'
import { qrText } from '../../signing/text'
import { sessionQuery } from '../../api/queries'
import { gamesWon, PATH, shown, sidesFor } from '../scoring/sides'
import '../scoring/scoring.css'

const ROUTE = '/_authenticated/matches/$matchId/scores/submission'

// Where a player lands after submitting a result. The URL's fragment is
// the signed result, and the other player confirms it from the QR code or
// the link, which carry the same bytes.
export function AwaitingValidation() {
  const { matchId } = useParams({ from: ROUTE })
  const { hash } = useLocation()
  const { api } = useRouteContext({ from: '__root__' })
  const { data: account } = useSuspenseQuery(sessionQuery(api))
  const showToast = useToast()
  const router = useRouter()
  const { scoring, fragment } = useLoaderData({ from: ROUTE })
  const self = { id: account.player.id, name: account.player.display_name }
  const match = matchOf(scoring, self, fragment?.result ?? null)
  if (!fragment) {
    return (
      <ErrorScreen
        title="This page has no result to share"
        actions={
          <Link to={PATH} params={{ matchId, gameNumber: '1' }} className="fm-btn fm-btn--primary">
            Go to the scores
          </Link>
        }
      >
        Its result is missing or damaged. Submit the result again from the scores.
      </ErrorScreen>
    )
  }
  const { envelope, result, signers } = fragment
  const side = signers[signers.length - 1]
  const other = match.players[otherSide(side)]
  const winner = matchWinner(result.games)
  const sides = sidesFor(side)
  // Same-origin, so it opens on a Preview and in dev as it does on fortymm.com.
  const path = router.buildLocation({
    to: '/matches/$matchId/scores/approvals/new',
    params: { matchId },
    hash,
  }).href
  const url = new URL(path, window.location.origin).href

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
            <b>{match.players[winner].name}</b> wins {gamesWon(tally(result.games), winner)}
          </p>
          <ol className="validation-games">
            {result.games.map((points, index) => (
              <li key={index}>
                Game {index + 1} <span className="num">{shown(points, sides)}</span>
              </li>
            ))}
          </ol>
        </section>
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
        <Link
          to={PATH}
          params={{ matchId, gameNumber: '1' }}
          hash={hash}
          className="fm-btn fm-btn--secondary validation-back"
        >
          Back to the scores
        </Link>
      </main>
    </div>
  )
}
