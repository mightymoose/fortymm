import { useEffect, useId, useRef, useState, type Ref } from 'react'
import { Button } from '../../components/Button'
import { closeDialog } from '../../components/closeDialog'
import { Icon } from '../../components/Icon'
import { ModalDialog } from '../../components/ModalDialog'
import { useToast } from '../../components/toastContext'
import { Home } from '../Home'
import { useAdoption } from './adoption'
import { MockupBar } from './parts'
import type { Answer, Question, ScenarioId } from './scenarios'

// This option's own words for the answers. Options 1 and 2 keep theirs.
const choices: readonly { answer: Answer; label: string; description: string }[] = [
  { answer: 'yes', label: 'This is me', description: 'Use this as my player profile.' },
  {
    answer: 'no',
    label: 'I manage this player',
    description: 'Manage this profile for someone else, such as my child.',
  },
  {
    answer: 'not-mine',
    label: 'Remove from my account',
    description: 'Disconnect this player. Their match history won’t be deleted.',
  },
]

function notYours(selfPlayer: string): string {
  return `You already play as ${selfPlayer}. We can’t combine two players yet.`
}

function confirmation(answer: Answer, name: string): string {
  switch (answer) {
    case 'yes':
      return `${name} is your player now.`
    case 'no':
      return `You manage ${name}.`
    case 'not-mine':
      return `${name} removed from your account.`
  }
}

// The initials of a display name's first two words, as PlayerAvatar shows.
function initials(displayName: string): string {
  return displayName
    .split(' ')
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase()
}

// Option 3: a dialog right after sign-in asks about one player at a time.
// "Skip this player" moves on without an answer, and "Review later" closes
// the dialog. Home keeps a short reminder of the players still to review.
export function Adopt3({ state }: { state: ScenarioId }) {
  const adoption = useAdoption(state)
  const showToast = useToast()
  const titleId = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const reviewButton = useRef<HTMLButtonElement>(null)
  const doneNotice = useRef<HTMLParagraphElement>(null)
  // Players skipped since the dialog opened. The dialog doesn't come back to
  // them until it opens again.
  const [skipped, setSkipped] = useState<readonly string[]>([])
  const [picked, setPicked] = useState<Answer | null>(null)
  // The answer the dialog confirms, with Undo, until the next one. A toast
  // can't do it while the dialog is open: the modal makes the page inert.
  const [last, setLast] = useState<{ question: Question; answer: Answer } | null>(null)
  const { scenario, open, selfPlayer } = adoption
  const queue = open.filter((question) => !skipped.includes(question.playerId))
  const current = queue[0]
  const total = scenario.questions.length

  // Focus goes to the first choice whenever a player shows, so a held Enter
  // on Continue can't answer the next player too.
  function focusFirstChoice() {
    dialog.current?.querySelector<HTMLElement>('input[type=radio]:not(:disabled)')?.focus()
  }

  function showDialog() {
    dialog.current?.showModal()
    focusFirstChoice()
  }

  function openDialog() {
    setSkipped([])
    setPicked(null)
    setLast(null)
    showDialog()
  }

  // Back to the reminder's button, or to the notice once nothing is left.
  function focusHome() {
    setTimeout(() => (reviewButton.current ?? doneNotice.current)?.focus())
  }

  useEffect(() => {
    if (scenario.signIn) showDialog()
  }, [scenario])

  useEffect(() => {
    if (!current && dialog.current?.open) dialog.current.close()
  }, [current])

  function next() {
    setPicked(null)
    setTimeout(focusFirstChoice)
  }

  function answer(question: Question, choice: Answer) {
    adoption.answer(question, choice)
    if (queue.length > 1) {
      setLast({ question, answer: choice })
      next()
      return
    }
    setLast(null)
    showToast(confirmation(choice, question.displayName), {
      undo: () => {
        adoption.undo(question)
        focusHome()
      },
    })
  }

  function skip(question: Question) {
    setSkipped((ids) => [...ids, question.playerId])
    setLast(null)
    next()
  }

  function undoLast() {
    if (!last) return
    adoption.undo(last.question)
    setLast(null)
    next()
  }

  return (
    <div className="adopt">
      <MockupBar state={state} />
      {open.length > 0 ? (
        <Reminder open={open} buttonRef={reviewButton} onReview={openDialog} />
      ) : (
        <p className="fm-notice fm-notice--success" ref={doneNotice} tabIndex={-1}>
          <Icon name="check" />
          <span>You reviewed every player from this device.</span>
        </p>
      )}
      <Home />
      <ModalDialog
        ref={dialog}
        className="fm-dialog adopt-review"
        aria-labelledby={titleId}
        onClose={focusHome}
      >
        {last && (
          <p className="fm-notice fm-notice--success" role="status">
            <Icon name="check" />
            <span>
              {confirmation(last.answer, last.question.displayName)}{' '}
              <Button variant="link" onClick={undoLast}>
                Undo
              </Button>
            </span>
          </p>
        )}
        {current && (
          <>
            <div className="adopt-review__head">
              {total > 1 && (
                <p className="meta">
                  Player {scenario.questions.indexOf(current) + 1} of {total}
                </p>
              )}
              <h2 id={titleId}>Who is {current.displayName}?</h2>
              <p>This player was used on this device before you signed in.</p>
            </div>
            <PlayerSummary question={current} />
            <fieldset className="adopt-options">
              <legend className="fm-sr">Who is {current.displayName}?</legend>
              {choices.map(({ answer: value, label, description }) => {
                const off = value === 'yes' && !!selfPlayer
                return (
                  <label key={value} className="fm-radio adopt-option">
                    <input
                      type="radio"
                      name={titleId}
                      value={value}
                      disabled={off}
                      checked={picked === value}
                      onChange={() => setPicked(value)}
                    />
                    <span className="adopt-option__text">
                      <span className="adopt-option__label">{label}</span>
                      <span className="fm-help">
                        {off && selfPlayer ? notYours(selfPlayer) : description}
                      </span>
                    </span>
                  </label>
                )
              })}
            </fieldset>
          </>
        )}
        <div className="fm-dialog__actions">
          {current && queue.length > 1 && (
            <Button variant="link" className="adopt-skip" onClick={() => skip(current)}>
              Skip this player
            </Button>
          )}
          <Button variant="secondary" onClick={closeDialog}>
            Review later
          </Button>
          <Button
            variant="primary"
            aria-disabled={picked ? undefined : true}
            onClick={() => current && picked && answer(current, picked)}
          >
            Continue
          </Button>
        </div>
      </ModalDialog>
    </div>
  )
}

// What helps a person recognise the player: when this device last used it,
// and its latest matches.
function PlayerSummary({ question }: { question: Question }) {
  return (
    <div className="adopt-player">
      <div className="adopt-player__who">
        <span className="fm-avatar" aria-hidden="true">
          {initials(question.displayName)}
        </span>
        <div>
          <p className="adopt-player__name">{question.displayName}</p>
          <p className="meta">Last used {question.lastUsed} on this device</p>
        </div>
      </div>
      {question.recentMatches.length > 0 ? (
        <ul className="adopt-player__matches" aria-label="Recent matches">
          {question.recentMatches.map(({ opponent, won, games, when }) => (
            <li key={`${opponent}-${when}`}>
              <span>
                {won ? 'Won' : 'Lost'} <span className="num">{games}</span> against {opponent}
              </span>
              <span className="meta">{when}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="meta">No matches yet.</p>
      )}
    </div>
  )
}

function Reminder({
  open,
  buttonRef,
  onReview,
}: {
  open: readonly Question[]
  buttonRef: Ref<HTMLButtonElement>
  onReview: () => void
}) {
  const one = open.length === 1
  return (
    <div className="fm-alert">
      <Icon name="info" />
      <p className="fm-alert__title">
        {one ? '1 player to review' : `${open.length} players to review`}
      </p>
      <p className="fm-alert__body">
        {one
          ? `${open[0].displayName} was used on this device before you signed in. Choose whether it belongs on your account.`
          : 'These players were used on this device before you signed in. Choose which belong on your account.'}
      </p>
      <div className="fm-alert__actions">
        <Button variant="primary" ref={buttonRef} onClick={onReview}>
          {one ? 'Review player' : 'Review players'}
        </Button>
      </div>
    </div>
  )
}
