import { useId, type ReactNode } from 'react'
import { Button } from '../../components/Button'
import { Icon } from '../../components/Icon'
import { GateGallery, type GalleryFrame } from './GateGallery'
import { DashboardToast } from './GateParts'
import {
  existingAccount,
  firstSignIn,
  largeHistory,
  longNames,
  manageConfirmation,
  matchCount,
  olderGuest,
  olderQuestion,
  outcome,
  PAGE,
  playerAfterNo,
  playerAfterYes,
  removeConfirmation,
  SHOWN,
  yesConfirmation,
  yesLabel,
  type Gate2Match,
  type Gate2Question,
} from './gate2Data'
import './loginGate2.css'

type Progress = { index: number; total: number }

type Step = {
  question: Gate2Question
  step: 1 | 2
  status?: 'saving' | 'error'
  // Only while more than one player is in the review.
  progress?: Progress
  // The confirmation of the answer before this one.
  saved?: string
  // Whether step 2's matches are open.
  open?: boolean
}

function Done({ player, message }: { player: string; message: string }) {
  return <DashboardToast player={player} message={message} undo={false} />
}

const frames: readonly GalleryFrame[] = [
  { title: 'Step 1, first sign-in', render: () => <Question question={firstSignIn} step={1} /> },
  {
    title: 'Step 1, sign-in to an existing account',
    render: () => <Question question={existingAccount} step={1} />,
  },
  {
    title: 'Step 1, the older guest player’s name survives',
    render: () => <Question question={olderGuest} step={1} />,
  },
  { title: 'Step 1, 48 matches', render: () => <Question question={largeHistory} step={1} /> },
  { title: 'View all 48 matches', render: () => <AllMatches question={largeHistory} /> },
  { title: 'Step 2', render: () => <Question question={existingAccount} step={2} /> },
  { title: 'Step 2, matches open', render: () => <Question question={largeHistory} step={2} open /> },
  { title: 'Saving', render: () => <Question question={existingAccount} step={1} status="saving" /> },
  { title: 'Error', render: () => <Question question={existingAccount} step={1} status="error" /> },
  { title: 'Long player names', render: () => <Question question={longNames} step={1} /> },
  {
    title: 'Done after Yes, first sign-in',
    render: () => <Done player={playerAfterYes(firstSignIn)} message={yesConfirmation(firstSignIn)} />,
  },
  {
    title: 'Done after Yes, existing account',
    render: () => <Done player={playerAfterYes(existingAccount)} message={yesConfirmation(existingAccount)} />,
  },
  {
    title: 'Done after Yes, the name changes',
    render: () => <Done player={playerAfterYes(olderGuest)} message={yesConfirmation(olderGuest)} />,
  },
  {
    title: 'Done after I manage this player',
    render: () => <Done player={playerAfterNo(existingAccount)} message={manageConfirmation(existingAccount)} />,
  },
  {
    title: 'Done after Remove from my account',
    render: () => <Done player={playerAfterNo(existingAccount)} message={removeConfirmation(existingAccount)} />,
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
    render: () => <Done player={playerAfterYes(existingAccount)} message={yesConfirmation(existingAccount)} />,
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

function Screen({ titleId, children }: { titleId: string; children: ReactNode }) {
  return (
    <div className="gate g2" role="group" aria-labelledby={titleId}>
      <div className="g2-wordmark">FortyMM</div>
      <div className="g2-body">{children}</div>
    </div>
  )
}

function Question({ question, step, status, progress, saved, open }: Step) {
  const titleId = useId()
  return (
    <Screen titleId={titleId}>
      {saved && (
        <p className="fm-notice fm-notice--success" role="status">
          <Icon name="check" />
          <span>
            {saved}
            {progress && (
              <span className="fm-sr">
                {' '}
                Player {progress.index} of {progress.total} next.
              </span>
            )}
          </span>
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
        <p className="g2-source">Played as {question.player}</p>
      </div>
      {step === 1 ? <Step1 question={question} status={status} /> : <Step2 question={question} open={open} />}
    </Screen>
  )
}

function MatchList({ matches, label }: { matches: readonly Gate2Match[]; label: string }) {
  return (
    <ul className="g2-list" aria-label={label}>
      {matches.map((match) => (
        <li key={`${match.date} ${match.time} ${match.opponent}`}>
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
  )
}

function summary(question: Gate2Question): string {
  return `${matchCount(question.total)} · ${question.range}`
}

// Up to 3 matches. With more, it says how many it shows and offers the
// rest. `withSummary` false leaves out the count and dates, for a place that
// already shows them.
function Matches({ question, withSummary = true }: { question: Gate2Question; withSummary?: boolean }) {
  const sample = question.total > SHOWN
  return (
    <div className="g2-matches">
      {withSummary && <p className="g2-matches__summary">{summary(question)}</p>}
      {sample && (
        <p className="g2-matches__head">
          <span>Recent matches</span>
          <span>
            Showing {SHOWN} of {question.total}
          </span>
        </p>
      )}
      <MatchList matches={question.matches.slice(0, SHOWN)} label={sample ? 'Recent matches' : 'Matches'} />
      {sample && (
        <Button variant="link" className="g2-view-all">
          View all {question.total} matches
        </Button>
      )}
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
            <p className="fm-alert__title">Your answer wasn’t saved. Please try again.</p>
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

function Step2({ question, open }: { question: Gate2Question; open?: boolean }) {
  return (
    <>
      <details className="fm-disclosure g2-review" open={open}>
        <summary>{summary(question)}</summary>
        <Matches question={question} withSummary={false} />
      </details>
      <div className="g2-actions">
        <Button variant="secondary" className="g2-choice">
          <span className="g2-choice__label">I manage this player</span>
          <span className="g2-choice__help">Keep this player separate in your account.</span>
        </Button>
        <Button variant="secondary" className="g2-choice">
          <span className="g2-choice__label">Remove from my account</span>
          <span className="g2-choice__help">The player and their matches will stay in FortyMM.</span>
        </Button>
        <Button variant="ghost" className="g2-back">
          <Icon name="left" />
          Back
        </Button>
      </div>
    </>
  )
}

// Every match of the question's player, a page at a time, in a box that
// scrolls. Back returns to the question.
function AllMatches({ question }: { question: Gate2Question }) {
  const titleId = useId()
  const loaded = Math.min(PAGE, question.total)
  return (
    <Screen titleId={titleId}>
      <Button variant="ghost" className="g2-back">
        <Icon name="left" />
        Back to the question
      </Button>
      <div className="g2-head">
        <h3 id={titleId} className="g2-title">
          All {question.total} matches
        </h3>
        <p className="g2-source">
          Played as {question.player} · {question.range}
        </p>
      </div>
      {/* tabIndex lets a keyboard scroll the box. */}
      <div className="g2-matches g2-all fm-scroll" role="region" aria-label="All matches" tabIndex={0}>
        <MatchList matches={question.matches.slice(0, loaded)} label="All matches" />
      </div>
      {loaded < question.total && (
        <div className="g2-more">
          <p className="g2-matches__head">
            Showing {loaded} of {question.total}
          </p>
          <Button variant="secondary">Load {Math.min(PAGE, question.total - loaded)} more</Button>
        </div>
      )}
    </Screen>
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
          Yes merges the question’s player and the account’s self player. The player created first survives.
          The other gets <code>merged_into</code> set to it, and no match moves. The copy names the surviving
          player, and says so when the account’s player gets a new name. So the API needs to say which player
          survives for each question. The gate doesn’t decide it from whether the account is new.
        </li>
        <li>
          The gate shows the 3 newest matches, with the total and the dates of the whole history. With more than
          3, “View all” opens every match in a box that scrolls, {PAGE} at a time. The API needs a paged list of a
          player’s matches. An answer always covers every match of the player.
        </li>
        <li>
          The counter shows only when the review holds more than one player. Its total is the questions
          answered in this review plus the questions still open. A new question goes to the end of the queue and
          adds 1. A question answered in another browser leaves the queue and takes 1 away. So “Player 1 of 1”
          never shows after an answer.
        </li>
        <li>
          The player on screen stays while the list changes. Step 2 and “View all” are the same question, so
          they don’t move the counter.
        </li>
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
          confirmation as a toast, and focus goes to the page. Nothing offers Undo.
        </li>
        <li>The gate only hides pages. The API’s authorization stays as it is.</li>
      </ul>
    </section>
  )
}
