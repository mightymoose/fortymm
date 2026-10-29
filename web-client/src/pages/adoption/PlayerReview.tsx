import { useMutation, useSuspenseQuery } from '@tanstack/react-query'
import { Link, Navigate, useNavigate, useRouteContext } from '@tanstack/react-router'
import { useEffect, useId, useReducer, useRef, type ReactNode } from 'react'
import {
  accountPlayersQuery,
  answerQuestionMutation,
  sessionQuery,
  type AccountPlayer,
  type Answer,
} from '../../api/queries'
import { Button, type ButtonVariant } from '../../components/Button'
import { Icon } from '../../components/Icon'
import { QueryBoundary } from '../../components/QueryBoundary'
import { useToast } from '../../components/toastContext'
import { Wordmark } from '../../components/Wordmark'
import './adoption.css'

type Step = 'recognize' | 'relationship'

// What this page has done since it opened. The step and the failed answer
// belong to one player, so the next player starts at `recognize` with no
// error, whatever ended the last one. `shown` holds every player this visit
// has queued, so the count holds when another tab answers one.
type Review = {
  shown: ReadonlySet<string>
  notice: string | null
  step: { playerId: string; step: Step } | null
  failed: { playerId: string; answer: Answer } | null
}

type ReviewEvent =
  | { type: 'go'; playerId: string; step: Step }
  | { type: 'queued'; shown: ReadonlySet<string> }
  | { type: 'save' }
  | { type: 'saved'; notice: string }
  | { type: 'failed'; playerId: string; answer: Answer }

function review(state: Review, event: ReviewEvent): Review {
  switch (event.type) {
    case 'go':
      return { ...state, step: { playerId: event.playerId, step: event.step }, failed: null }
    case 'queued':
      return { ...state, shown: event.shown }
    case 'save':
      return { ...state, notice: null, failed: null }
    case 'saved':
      return { ...state, notice: event.notice }
    case 'failed':
      return { ...state, failed: { playerId: event.playerId, answer: event.answer } }
  }
}

const start: Review = { shown: new Set(), notice: null, step: null, failed: null }

// `survivor` is the account's older player, when "Yes" merged the player
// into it.
function confirmation(answer: Answer, name: string, survivor?: string): string {
  switch (answer) {
    case 'yes':
      return survivor ? `${name} merged into ${survivor}, your player.` : `${name} is your player now.`
    case 'no':
      return `${name} added to players you manage.`
    case 'not_mine':
      return `${name} removed from your account.`
  }
}

const SAVE_ERROR = 'Your answer wasn’t saved. Please try again.'

// "Is this you?" for each player a sign-in brought to the account, one
// player at a time, styled by `.review-*` in adoption.css. A player is
// either the visitor, someone they manage, or not theirs. The page goes back
// to Home once no question is open, with a toast for the last answer. A
// guest has no questions, so it goes Home without asking for players.
export function PlayerReview() {
  const { api } = useRouteContext({ from: '__root__' })
  const { data: account } = useSuspenseQuery(sessionQuery(api))
  if (account.kind !== 'verified') return <Navigate to="/" replace />
  return (
    <div className="review">
      <header className="review-top">
        <Wordmark />
      </header>
      <ReviewQuestions selfName={account.player.display_name} />
    </div>
  )
}

function ReviewQuestions({ selfName }: { selfName: string }) {
  return (
    <QueryBoundary
      skeleton={<ReviewSkeleton />}
      actions={
        <Link to="/" className="fm-btn fm-btn--ghost fm-btn--sm">
          Go to Home
        </Link>
      }
    >
      <Questions selfName={selfName} />
    </QueryBoundary>
  )
}

// The shape of the question and its action bar, while the players load.
function ReviewSkeleton() {
  return (
    <>
      <main className="review-content" aria-busy="true">
        <span className="fm-sr" role="status">
          Loading players
        </span>
        <div className="fm-skeleton review-skeleton review-skeleton--counter" aria-hidden="true" />
        <div className="fm-skeleton review-skeleton review-skeleton--question" aria-hidden="true" />
        <div className="fm-skeleton review-skeleton review-skeleton--line" aria-hidden="true" />
      </main>
      <div className="review-actions" aria-hidden="true">
        <div className="fm-skeleton review-skeleton review-skeleton--outcome" />
        <div className="fm-skeleton review-skeleton review-skeleton--button" />
        <div className="fm-skeleton review-skeleton review-skeleton--button" />
        <div className="fm-skeleton review-skeleton review-skeleton--later" />
      </div>
    </>
  )
}

function Questions({ selfName }: { selfName: string }) {
  const { api, queryClient } = useRouteContext({ from: '__root__' })
  const { data: players } = useSuspenseQuery(accountPlayersQuery(api))
  const answer = useMutation(answerQuestionMutation(api, queryClient))
  const navigate = useNavigate()
  const showToast = useToast()
  const [state, dispatch] = useReducer(review, start)
  const heading = useRef<HTMLHeadingElement>(null)
  // `answer.isPending` is from the last render, so a second click before
  // the next one would send a second answer.
  const sending = useRef(false)

  const queue = players.filter((player) => player.open_question)
  const current = queue.at(0)
  const step = current && state.step?.playerId === current.id ? state.step.step : 'recognize'
  const failed = current && state.failed?.playerId === current.id ? state.failed.answer : null
  const saving = answer.isPending ? answer.variables.answer : null
  const shown = new Set([...state.shown, ...queue.map((player) => player.id)])
  if (shown.size > state.shown.size) dispatch({ type: 'queued', shown })
  const total = shown.size

  useEffect(() => {
    heading.current?.focus({ preventScroll: true })
    window.scrollTo(0, 0)
  }, [current?.id, step])

  if (!current) return <Navigate to="/" replace state={{ fromReview: true }} />
  const player = current

  // Awaited rather than passed to `mutate`, because answering the last
  // player leaves the page before `mutate`'s callbacks would run.
  async function save(choice: Answer) {
    if (sending.current) return
    sending.current = true
    dispatch({ type: 'save' })
    let after: AccountPlayer[]
    try {
      after = await answer.mutateAsync({ player, answer: choice })
    } catch {
      dispatch({ type: 'failed', playerId: player.id, answer: choice })
      // A 409 means another tab answered first.
      void queryClient.refetchQueries(accountPlayersQuery(api))
      return
    } finally {
      sending.current = false
    }
    const self = after.find((found) => found.relationship === 'self')
    const survivor = self && self.id !== player.id ? self.display_name : undefined
    const message = confirmation(choice, player.display_name, survivor)
    if (after.some((found) => found.open_question)) dispatch({ type: 'saved', notice: message })
    else showToast(message)
  }

  function go(next: Step) {
    dispatch({ type: 'go', playerId: player.id, step: next })
  }

  // A button that answers the question. While an answer saves, every other
  // action waits.
  function answerButton(value: Answer, variant: ButtonVariant, label: string) {
    return (
      <SaveButton
        variant={variant}
        busy={saving === value}
        disabled={saving !== null && saving !== value}
        failed={failed === value}
        onClick={() => void save(value)}
      >
        {label}
      </SaveButton>
    )
  }

  const counter = total > 1 && (
    <p className="review-counter">
      Player {total - queue.length + 1} of {total}
    </p>
  )
  const notice = state.notice && (
    <p className="fm-notice fm-notice--success review-saved" role="status">
      <Icon name="check" />
      <span>{state.notice}</span>
    </p>
  )

  return step === 'recognize' ? (
    <>
      <main className="review-content">
        {counter}
        <h1 className="h2 review-q" ref={heading} tabIndex={-1}>
          Is this you?
        </h1>
        <p className="review-playedas">
          <b>{current.display_name}</b> was used on this device before you signed in.
        </p>
      </main>
      <div className="review-actions" role="group" aria-label="Your answer">
        {notice}
        <p className="review-outcome">
          <b>{current.display_name}</b> and <b>{selfName}</b> will become
          one player, your player.
        </p>
        {answerButton('yes', 'primary', 'Yes, this is me')}
        <Button
          variant="secondary"
          size="lg"
          disabled={saving !== null}
          onClick={() => go('relationship')}
        >
          Someone else played
        </Button>
        <Button
          variant="ghost"
          disabled={saving !== null}
          onClick={() => void navigate({ to: '/', state: { fromReview: true } })}
        >
          Review later
        </Button>
      </div>
    </>
  ) : (
    <>
      <main className="review-content">
        {counter}
        <h1 className="h2 review-q" ref={heading} tabIndex={-1}>
          Do you manage this player?
        </h1>
        <div className="review-ident">
          <p className="h3 review-ident__name">{current.display_name}</p>
        </div>
      </main>
      <div className="review-actions" role="group" aria-label="Your answer">
        {notice}
        {answerButton('no', 'primary', 'I manage this player')}
        {answerButton('not_mine', 'secondary', 'Remove from my account')}
        <p className="review-note">The player and their matches will stay in FortyMM.</p>
        <Button variant="ghost" disabled={saving !== null} onClick={() => go('recognize')}>
          <Icon name="back" />
          Back
        </Button>
      </div>
    </>
  )
}

// A large button that saves an answer, with the error of a save that failed
// right under it.
function SaveButton({
  variant,
  busy,
  disabled,
  failed,
  onClick,
  children,
}: {
  variant: ButtonVariant
  busy: boolean
  disabled: boolean
  failed: boolean
  onClick: () => void
  children: ReactNode
}) {
  const errorId = useId()
  return (
    <>
      <Button
        variant={variant}
        size="lg"
        busy={busy}
        disabled={disabled}
        aria-describedby={failed ? errorId : undefined}
        onClick={onClick}
      >
        {busy ? 'Saving…' : children}
      </Button>
      {failed && (
        <p className="fm-error review-error" id={errorId} role="alert">
          <Icon name="error" />
          {SAVE_ERROR}
        </p>
      )}
    </>
  )
}
