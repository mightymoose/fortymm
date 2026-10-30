import { useMutation, useSuspenseQuery } from '@tanstack/react-query'
import { Link, Navigate, useNavigate, useRouteContext } from '@tanstack/react-router'
import { useEffect, useId, useReducer, useRef, type ReactNode } from 'react'
import {
  accountPlayersQuery,
  answerQuestionMutation,
  sessionQuery,
  type AccountPlayer,
  type AnswerMeta,
  type Reply,
} from '../../api/queries'
import { ApiError } from '../../api/errors'
import { Button, type ButtonVariant } from '../../components/Button'
import { Icon } from '../../components/Icon'
import { QueryBoundary } from '../../components/QueryBoundary'
import { useToast, type ToastIcon } from '../../components/toastContext'
import { Wordmark } from '../../components/Wordmark'
import './adoption.css'

type Step = 'recognize' | 'relationship' | 'choose'

// What the last answer did, or why it didn't count.
type Notice = { text: string; icon: ToastIcon }

// One answer button's reply, as text: the answer, or `same_as:` and the
// player it names. Each button shows its own Saving… and error.
type ReplyKey = string

function replyKey(reply: Reply): ReplyKey {
  return reply.answer === 'same_as' ? `same_as:${reply.player_id}` : reply.answer
}

// What this page has done since it opened. The step and the failed answer
// belong to one player, so the next player starts at `recognize` with no
// error, whatever ended the last one. `shown` holds every player this visit
// has queued, so the count holds when another tab answers one.
type Review = {
  shown: ReadonlySet<string>
  notice: Notice | null
  step: { playerId: string; step: Step } | null
  failed: { playerId: string; reply: ReplyKey } | null
}

type ReviewEvent =
  | { type: 'go'; playerId: string; step: Step }
  | { type: 'queued'; shown: ReadonlySet<string> }
  | { type: 'save' }
  | { type: 'saved'; notice: Notice }
  | { type: 'failed'; playerId: string; reply: ReplyKey }

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
      return { ...state, failed: { playerId: event.playerId, reply: event.reply } }
  }
}

const start: Review = { shown: new Set(), notice: null, step: null, failed: null }

function selfPlayer(players: readonly AccountPlayer[]): AccountPlayer | undefined {
  return players.find((found) => found.relationship === 'self')
}

function alreadyAnswered(player: AccountPlayer): Notice {
  return { text: `${player.display_name} was already answered in another tab.`, icon: 'info' }
}

// What `meta` says the answer for `player` did. `before` and `after` are the
// account's players around the answer. A merged player has left `after`, so
// its name comes from `before`.
function confirmation(
  meta: AnswerMeta,
  player: AccountPlayer,
  before: readonly AccountPlayer[],
  after: readonly AccountPlayer[],
): Notice {
  const name = player.display_name
  switch (meta.outcome) {
    case 'self':
      return { text: `${name} is your player now.`, icon: 'check' }
    case 'merged': {
      const names = new Map([...before, ...after].map((found) => [found.id, found.display_name]))
      const merged = names.get(meta.merged) ?? 'A player'
      const into = names.get(meta.survivor) ?? 'another player'
      const isSelf = after.some((found) => found.id === meta.survivor && found.relationship === 'self')
      const text = isSelf
        ? `${merged} merged into ${into}, your player.`
        : `${merged} merged into ${into}.`
      return { text, icon: 'check' }
    }
    case 'managed':
      return { text: `${name} added to players you manage.`, icon: 'check' }
    case 'removed':
      return { text: `${name} removed from your account.`, icon: 'check' }
    case 'already_answered':
      return alreadyAnswered(player)
  }
}

const SAVE_ERROR = 'Your answer wasn’t saved. Please try again.'

// "Is this you?" for each player a sign-in brought to the account, one
// player at a time, styled by `.review-*` in adoption.css. A player is
// either the visitor, someone they manage, or not theirs. Someone they
// manage can be a player the account already manages, and then the two
// merge. The page goes back to Home once no question is open, with a toast
// for the last answer. A guest has no questions, so it goes Home without
// asking for players.
export function PlayerReview() {
  const { api } = useRouteContext({ from: '__root__' })
  const { data: account } = useSuspenseQuery(sessionQuery(api))
  if (account.kind !== 'verified') return <Navigate to="/" replace />
  return (
    <div className="review">
      <header className="review-top">
        <Wordmark />
      </header>
      <ReviewQuestions />
    </div>
  )
}

function ReviewQuestions() {
  return (
    <QueryBoundary
      skeleton={<ReviewSkeleton />}
      actions={
        <Link to="/" className="fm-btn fm-btn--ghost fm-btn--sm">
          Go to Home
        </Link>
      }
    >
      <Questions />
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
        <div className="fm-skeleton review-skeleton review-skeleton--preview" aria-hidden="true" />
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

function Questions() {
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
  const failed = current && state.failed?.playerId === current.id ? state.failed.reply : null
  const saving = answer.isPending ? replyKey(answer.variables.reply) : null
  const shown = new Set([...state.shown, ...queue.map((player) => player.id)])
  if (shown.size > state.shown.size) dispatch({ type: 'queued', shown })
  const total = shown.size
  const own = selfPlayer(players)
  // The players that "I manage this player" can merge the player into.
  const targets = players.filter(
    (found) => found.relationship === 'managed' && !found.open_question && found.id !== current?.id,
  )

  useEffect(() => {
    heading.current?.focus({ preventScroll: true })
    window.scrollTo(0, 0)
  }, [current?.id, step])

  if (!current) return <Navigate to="/" replace state={{ fromReview: true }} />
  const player = current

  // Awaited rather than passed to `mutate`, because answering the last
  // player leaves the page before `mutate`'s callbacks would run.
  async function save(reply: Reply) {
    if (sending.current) return
    sending.current = true
    dispatch({ type: 'save' })
    const before = players
    let answered: { players: AccountPlayer[]; meta: AnswerMeta }
    try {
      answered = await answer.mutateAsync({ player, reply })
    } catch (error) {
      if (!(await answeredElsewhere(error, reply))) {
        dispatch({ type: 'failed', playerId: player.id, reply: replyKey(reply) })
      }
      return
    } finally {
      sending.current = false
    }
    finish(confirmation(answered.meta, player, before, answered.players), answered.players)
  }

  // Whether `error` means another tab answered the player first. The API
  // answers 409 only to "Remove from my account" on a closed question. A 404
  // can mean that another tab merged the player, so the refetched players
  // must leave it out. Then the page says so in place of an error that would
  // go with the player. A 404 to `same_as` can instead mean that the chosen
  // player is gone, and its button with it, so the page says that.
  async function answeredElsewhere(error: unknown, reply: Reply): Promise<boolean> {
    if (!(error instanceof ApiError && (error.status === 404 || error.status === 409))) return false
    const { queryKey } = accountPlayersQuery(api)
    await queryClient.refetchQueries({ queryKey })
    const now = queryClient.getQueryData(queryKey)
    if (!now) return false
    if (error.status === 404 && now.some((found) => found.id === player.id && found.open_question)) {
      if (reply.answer !== 'same_as' || now.some((found) => found.id === reply.player_id)) return false
      const gone = players.find((found) => found.id === reply.player_id)?.display_name ?? 'That player'
      dispatch({ type: 'saved', notice: { text: `${gone} isn’t one of your players any more.`, icon: 'info' } })
      return true
    }
    finish(alreadyAnswered(player), now)
    return true
  }

  // Shows `notice` above the next question, or as a toast on Home when no
  // question is left.
  function finish(notice: Notice, after: readonly AccountPlayer[]) {
    if (after.some((found) => found.open_question)) dispatch({ type: 'saved', notice })
    else showToast(notice.text, { icon: notice.icon })
  }

  function go(next: Step) {
    dispatch({ type: 'go', playerId: player.id, step: next })
  }

  // The props of a button that sends `reply`. While an answer saves, every
  // other action waits.
  function sends(reply: Reply) {
    const key = replyKey(reply)
    return {
      busy: saving === key,
      disabled: saving !== null && saving !== key,
      failed: failed === key,
      onClick: () => void save(reply),
    }
  }

  function answerButton(reply: Reply, variant: ButtonVariant, label: string) {
    return (
      <SaveButton variant={variant} {...sends(reply)}>
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
    <p
      className={
        state.notice.icon === 'check' ? 'fm-notice fm-notice--success review-saved' : 'fm-notice review-saved'
      }
      role="status"
    >
      <Icon name={state.notice.icon} />
      <span>{state.notice.text}</span>
    </p>
  )

  if (step === 'recognize') {
    return (
      <>
        <main className="review-content">
          {counter}
          <h1 className="h2 review-q" ref={heading} tabIndex={-1}>
            Is this you?
          </h1>
          <p className="review-playedas">
            <b>{current.display_name}</b> was used on this device before you signed in.
          </p>
          {/* No player has a match yet. The games work adds the player's
              recent matches here, and a way to see them all. */}
          <section className="review-preview" aria-label="Recent matches">
            <p className="review-preview__head">No matches yet</p>
          </section>
        </main>
        <div className="review-actions" role="group" aria-label="Your answer">
          {notice}
          {own && (
            <p className="review-outcome">
              <b>{current.display_name}</b> and <b>{own.display_name}</b> will become
              one player, your player.
            </p>
          )}
          {answerButton({ answer: 'yes' }, 'primary', 'Yes, this is me')}
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
    )
  }

  if (step === 'relationship') {
    return (
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
          {targets.length > 0 ? (
            <Button
              variant="primary"
              size="lg"
              disabled={saving !== null}
              // The second click of a double click on "Someone else
              // played" can land here, as on an answer.
              onClick={(event) => {
                if (event.detail <= 1) go('choose')
              }}
            >
              I manage this player
            </Button>
          ) : (
            answerButton({ answer: 'no' }, 'primary', 'I manage this player')
          )}
          {answerButton({ answer: 'not_mine' }, 'secondary', 'Remove from my account')}
          <p className="review-note">The player and their matches will stay in FortyMM.</p>
          <Button variant="ghost" disabled={saving !== null} onClick={() => go('recognize')}>
            <Icon name="back" />
            Back
          </Button>
        </div>
      </>
    )
  }

  return (
    <>
      <main className="review-content">
        {counter}
        <h1 className="h2 review-q" ref={heading} tabIndex={-1}>
          Which player?
        </h1>
        <p className="review-playedas">
          Matches from <b>{current.display_name}</b>
        </p>
        <p className="review-support">Choose a player to add these matches to.</p>
        <div className="review-choice" role="group" aria-label="Your answer">
          {notice}
          <ul className="review-dests">
            {targets.map((target) => (
              <li key={target.id}>
                <DestButton {...sends({ answer: 'same_as', player_id: target.id })}>
                  {target.display_name}
                </DestButton>
              </li>
            ))}
            <li className="review-dests__sep">
              <DestButton {...sends({ answer: 'no' })}>Keep as a separate player</DestButton>
            </li>
          </ul>
        </div>
      </main>
      <div className="review-actions review-actions--nav" role="group" aria-label="Navigation">
        <Button
          variant="ghost"
          disabled={saving !== null}
          // The second click of a double click on "I manage this player"
          // can land here.
          onClick={(event) => {
            if (event.detail <= 1) go('relationship')
          }}
        >
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
        // A second click of a double click is the same gesture. By then the
        // answer may have saved and moved the next player's button under it.
        onClick={(event) => {
          if (event.detail <= 1) onClick()
        }}
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

// A player to merge into on "Which player?", or "Keep as a separate
// player", with the error of a save that failed right under it. Its name is
// the whole label, because no player has matches to list yet.
function DestButton({
  busy,
  disabled,
  failed,
  onClick,
  children,
}: {
  busy: boolean
  disabled: boolean
  failed: boolean
  onClick: () => void
  children: ReactNode
}) {
  const errorId = useId()
  return (
    <>
      <button
        type="button"
        className="review-dest"
        aria-busy={busy || undefined}
        disabled={disabled}
        aria-describedby={failed ? errorId : undefined}
        // As for SaveButton.
        onClick={(event) => {
          if (event.detail <= 1) onClick()
        }}
      >
        <span className="review-dest__name">{children}</span>
        {busy && <span className="review-dest__meta">Saving…</span>}
      </button>
      {failed && (
        <p className="fm-error review-error" id={errorId} role="alert">
          <Icon name="error" />
          {SAVE_ERROR}
        </p>
      )}
    </>
  )
}
