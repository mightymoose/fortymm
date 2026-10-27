import { useId } from 'react'
import { Button } from '../../components/Button'
import { Icon } from '../../components/Icon'
import { GateGallery, type GalleryFrame } from './GateGallery'
import { DashboardToast } from './GateParts'
import {
  existingAccount,
  firstSignIn,
  longNames,
  manageConfirmation,
  matchCount,
  olderQuestion,
  outcome,
  removeConfirmation,
  yesConfirmation,
  yesLabel,
  type Gate2Question,
} from './gate2Data'
import './loginGate2.css'

type Step = {
  question: Gate2Question
  step: 1 | 2
  status?: 'saving' | 'error'
  // Only while more than one player is in the review.
  progress?: { index: number; total: number }
  // The confirmation of the answer before this one.
  saved?: string
}

const frames: readonly GalleryFrame[] = [
  { title: 'Step 1, first sign-in', render: () => <Question question={firstSignIn} step={1} /> },
  {
    title: 'Step 1, sign-in to an existing account',
    render: () => <Question question={existingAccount} step={1} />,
  },
  { title: 'Step 2', render: () => <Question question={existingAccount} step={2} /> },
  { title: 'Saving', render: () => <Question question={existingAccount} step={1} status="saving" /> },
  { title: 'Error', render: () => <Question question={existingAccount} step={1} status="error" /> },
  { title: 'Long player names', render: () => <Question question={longNames} step={1} /> },
  {
    title: 'Done after Yes, first sign-in',
    render: () => <DashboardToast player={firstSignIn.player} message={yesConfirmation(firstSignIn)} />,
  },
  {
    title: 'Done after Yes, existing account',
    render: () => <DashboardToast player={existingAccount.survivor} message={yesConfirmation(existingAccount)} />,
  },
  {
    title: 'Done after I manage this player',
    render: () => <DashboardToast player={existingAccount.survivor} message={manageConfirmation(existingAccount)} />,
  },
  {
    title: 'Done after Remove from my account',
    render: () => <DashboardToast player={existingAccount.survivor} message={removeConfirmation(existingAccount)} />,
  },
  {
    title: 'Two players: the first, oldest question',
    render: () => <Question question={olderQuestion} step={1} progress={{ index: 1, total: 2 }} />,
  },
  {
    title: 'Two players: Someone else played stays on player 1',
    render: () => <Question question={olderQuestion} step={2} progress={{ index: 1, total: 2 }} />,
  },
  {
    title: 'Two players: the next player after I manage this player',
    render: () => (
      <Question
        question={existingAccount}
        step={1}
        progress={{ index: 2, total: 2 }}
        saved={manageConfirmation(olderQuestion)}
      />
    ),
  },
  {
    title: 'Two players: done after Yes on the last one',
    render: () => <DashboardToast player={existingAccount.survivor} message={yesConfirmation(existingAccount)} />,
  },
]

// Layout 2, activity first: one centred column that leads with the matches,
// and asks about one player at a time.
export function LoginGate2() {
  return (
    <GateGallery
      current="/login-gate2"
      description="One column that leads with the matches, because people recognize their matches, not a random name. It asks about one player at a time."
      frames={frames}
    >
      <Requirements />
    </GateGallery>
  )
}

function Question({ question, step, status, progress, saved }: Step) {
  const titleId = useId()
  return (
    <div className="gate g2" role="group" aria-labelledby={titleId}>
      <div className="g2-wordmark">FortyMM</div>
      <div className="g2-body">
        {saved && (
          <p className="fm-notice fm-notice--success g2-saved" role="status">
            <Icon name="check" />
            <span>
              {saved}
              {progress && <span className="fm-sr"> Player {progress.index} of {progress.total} next.</span>}
            </span>
            <Button variant="link" className="g2-undo">
              Undo
            </Button>
          </p>
        )}
        <div className="g2-head">
          {progress && (
            <p className="g2-progress">
              Player {progress.index} of {progress.total}
            </p>
          )}
          <h3 id={titleId} className="g2-title">
            {step === 1 ? 'Did you play these matches?' : 'Do you manage this player?'}
          </h3>
          {/* Step 2's answers name the player, so it isn't named here too. */}
          {step === 1 && <p className="g2-source">Played as {question.player}</p>}
        </div>
        {step === 1 ? <Step1 question={question} status={status} /> : <Step2 question={question} />}
      </div>
    </div>
  )
}

function Matches({ question }: { question: Gate2Question }) {
  const sample = question.matches.length < question.total
  return (
    <div className="g2-matches">
      <p className="g2-matches__head">
        <span>{sample ? 'Recent matches' : matchCount(question.total)}</span>
        {sample && (
          <span>
            {question.matches.length} of {question.total}
          </span>
        )}
      </p>
      <ul aria-label={sample ? 'Recent matches' : 'Matches'}>
        {question.matches.map((match) => (
          <li key={`${match.date} ${match.time}`}>
            <span className="g2-match__who">
              <span className="g2-match__opponent">{match.opponent}</span>
              <span className="g2-match__when">
                {match.date}, {match.time}
              </span>
            </span>
            <span className={match.won ? 'g2-match__result g2-match__result--won' : 'g2-match__result'}>
              {match.won ? 'Won' : 'Lost'} <span className="num">{match.score}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Step1({ question, status }: { question: Gate2Question; status?: 'saving' | 'error' }) {
  const saving = status === 'saving'
  return (
    <>
      <Matches question={question} />
      <p className="g2-outcome">{outcome(question)}</p>
      <div className="g2-actions">
        {status === 'error' && (
          <div className="fm-alert fm-alert--error" role="alert">
            <Icon name="error" />
            <p className="fm-alert__title">Your answer wasn’t saved</p>
            <p className="fm-alert__body">Check your connection, then tap {yesLabel(question)} again.</p>
          </div>
        )}
        <Button variant="primary" size="xl" busy={saving}>
          {saving ? 'Saving…' : yesLabel(question)}
        </Button>
        <Button variant="secondary" size="xl" aria-disabled={saving || undefined}>
          Someone else played
        </Button>
      </div>
    </>
  )
}

function Step2({ question }: { question: Gate2Question }) {
  const latest = question.matches[0]
  return (
    <>
      <details className="fm-disclosure g2-review">
        <summary>
          {matchCount(question.total)}, the latest on {latest.date}
        </summary>
        <Matches question={question} />
      </details>
      <div className="g2-actions">
        <Button variant="secondary" className="g2-choice">
          <span className="g2-choice__label">I manage this player</span>
          <span className="g2-choice__help">Keep {question.player} as a separate player in your account.</span>
        </Button>
        <Button variant="secondary" className="g2-choice">
          <span className="g2-choice__label">Remove from my account</span>
          <span className="g2-choice__help">{question.player} and their matches will stay in FortyMM.</span>
        </Button>
        <Button variant="ghost" className="g2-back">
          <Icon name="left" />
          Back
        </Button>
      </div>
    </>
  )
}

// What the real gate must do. The frames above are static, so they show
// these rules but don't run them.
function Requirements() {
  return (
    <section className="g2-reqs" aria-labelledby="g2-reqs-title">
      <h2 id="g2-reqs-title">What the real gate must do</h2>
      <p className="meta">The frames are static. They show these rules, but nothing on this page runs them.</p>
      <ul>
        <li>
          The gate reads the open questions from <code>GET /v1/account/players</code>, not from{' '}
          <code>signed_in=1</code>. <code>AuthenticatedLayout</code> checks for any player with{' '}
          <code>open_question</code>, so a reload or a direct link to any authenticated page reaches the gate.
        </li>
        <li>
          The loading screen stays up until that check answers, so the requested page never shows before the
          gate.
        </li>
        <li>
          The gate asks about one player at a time, oldest question first, with the player id as tie-breaker.
          The API lists players by display name today, so it needs to give each question’s time.
        </li>
        <li>
          Yes merges the player into the account’s self player, and the player created first keeps its name.
          The copy names that player, so the API needs to say which player survives for each question. The
          gate doesn’t decide it from whether the account is new.
        </li>
        <li>
          The counter shows only when the review holds more than one player. Its total is the questions
          answered in this review plus the questions still open. A new question goes to the end of the queue and
          adds 1. A question answered in another browser leaves the queue and takes 1 away. So “Player 1 of 1”
          never shows after an answer.
        </li>
        <li>The player on screen stays while the list changes. Step 2 is the same question, so it doesn’t move the counter.</li>
        <li>
          After each saved answer, the gate fetches the list again, then picks the next question. It also
          fetches the list when the tab gets focus again.
        </li>
        <li>
          The answer route returns the list. If the list doesn’t match the answer, or the route answers 404 or
          409, another browser answered first. The gate says so, sends nothing more for that player and moves on.
        </li>
        <li>
          The gate sends one answer at a time. The tapped button shows Saving…, and the other answers are off
          until the request ends. If the request fails, one alert says so, and the same button tries again.
        </li>
        <li>
          After an answer, a status notice confirms it and names the next player for screen readers. Focus goes
          to the next player’s heading. When no question is left, the gate shows the requested page, with the
          confirmation as a toast, and focus goes to the page.
        </li>
        <li>
          Undo needs an API route that opens the question again, and none exists yet. After an Undo, the
          question is open, so the gate comes back with that player.
        </li>
        <li>The gate only hides pages. The API’s authorization stays as it is.</li>
      </ul>
    </section>
  )
}
