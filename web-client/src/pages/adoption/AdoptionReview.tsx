import { useMutation, useQuery } from '@tanstack/react-query'
import { useNavigate, useRouteContext, useSearch } from '@tanstack/react-router'
import { useEffect, useEffectEvent, useId, useRef, useState, type Ref } from 'react'
import {
  accountPlayersQuery,
  answerQuestionMutation,
  sessionQuery,
  type AccountPlayer,
  type Answer,
} from '../../api/queries'
import { Button } from '../../components/Button'
import { closeDialog } from '../../components/closeDialog'
import { Icon } from '../../components/Icon'
import { initials } from '../../components/initials'
import { ModalDialog } from '../../components/ModalDialog'
import { useToast } from '../../components/toastContext'
import './adoption.css'

const choices: readonly { answer: Answer; label: string; description: string }[] = [
  { answer: 'yes', label: 'This is me', description: 'Use this as my player profile.' },
  {
    answer: 'no',
    label: 'I manage this player',
    description: 'Manage this profile for someone else, such as my child.',
  },
  {
    answer: 'not_mine',
    label: 'Remove from my account',
    description: 'Disconnect this player. Their match history won’t be deleted.',
  },
]

// `survivor` is the account's older player, when "This is me" merged the
// player into it.
function confirmation(answer: Answer, name: string, survivor?: string): string {
  switch (answer) {
    case 'yes':
      return survivor ? `${name} merged into ${survivor}, your player.` : `${name} is your player now.`
    case 'no':
      return `You manage ${name}.`
    case 'not_mine':
      return `${name} removed from your account.`
  }
}

// "Is this you?" for each player a sign-in brought to the account. Home shows
// a reminder of the players still to review, and a dialog asks about one
// player at a time. The dialog opens by itself right after a sign-in.
// "Skip this player" moves on without an answer, and "Review later" closes
// the dialog.
export function AdoptionReview() {
  const { api, queryClient } = useRouteContext({ from: '__root__' })
  const { data: account } = useQuery(sessionQuery(api))
  const { data: players } = useQuery({
    ...accountPlayersQuery(api),
    enabled: account?.kind === 'verified',
  })
  const answer = useMutation(answerQuestionMutation(api, queryClient))
  const { signed_in: signedIn } = useSearch({ from: '/_authenticated/' })
  const navigate = useNavigate({ from: '/' })
  const showToast = useToast()
  const titleId = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const reviewButton = useRef<HTMLButtonElement>(null)
  const doneNotice = useRef<HTMLParagraphElement>(null)
  // How many players the dialog answered since it opened, for "Player N of
  // M".
  const [answeredHere, setAnsweredHere] = useState(0)
  // Players skipped since the dialog opened. The dialog doesn't come back to
  // them until it opens again.
  const [skipped, setSkipped] = useState<readonly string[]>([])
  const [picked, setPicked] = useState<Answer | null>(null)
  // The answer the dialog confirms while more players remain. A toast can't
  // do it while the dialog is open: the modal makes the page inert.
  const [last, setLast] = useState<string | null>(null)
  // Whether this page load answered a question, so the notice that every
  // player is reviewed shows only after an answer.
  const [answered, setAnswered] = useState(false)

  const open = players?.filter((player) => player.open_question) ?? []
  const queue = open.filter((player) => !skipped.includes(player.id))
  const current = queue[0]
  const total = answeredHere + skipped.length + queue.length

  // Focus goes to the first choice whenever a player shows, so a held Enter
  // on Continue can't answer the next player too.
  function focusFirstChoice() {
    dialog.current?.querySelector<HTMLElement>('input[type=radio]')?.focus()
  }

  function showDialog() {
    if (!dialog.current?.open) dialog.current?.showModal()
    focusFirstChoice()
  }

  function openDialog() {
    setAnsweredHere(0)
    setSkipped([])
    setPicked(null)
    setLast(null)
    showDialog()
  }

  // Back to the reminder's button, or to the notice once nothing is left.
  function focusHome() {
    setTimeout(() => (reviewButton.current ?? doneNotice.current)?.focus())
  }

  // Right after a sign-in, with the dialog's state as it starts. Then the
  // marker leaves the URL, so a reload shows only the reminder.
  const openAfterSignIn = useEffectEvent(() => {
    if (open.length > 0) showDialog()
    void navigate({ search: {}, replace: true })
  })
  const loaded = players !== undefined
  useEffect(() => {
    if (signedIn && loaded) openAfterSignIn()
  }, [signedIn, loaded])

  useEffect(() => {
    if (!current && dialog.current?.open) dialog.current.close()
  }, [current])

  function next() {
    setPicked(null)
    setTimeout(focusFirstChoice)
  }

  function submit(player: AccountPlayer, choice: Answer) {
    if (answer.isPending) return
    const more = queue.length > 1
    answer.mutate(
      { player, answer: choice },
      {
        onSuccess: (after) => {
          const self = after.find((found) => found.relationship === 'self')
          const survivor = self && self.id !== player.id ? self.display_name : undefined
          const message = confirmation(choice, player.display_name, survivor)
          setAnswered(true)
          setAnsweredHere((count) => count + 1)
          if (more) {
            setLast(message)
            next()
            return
          }
          setLast(null)
          dialog.current?.close()
          showToast(message)
        },
        onError: () => {
          // Closed first, so the toast isn't under the inert page.
          dialog.current?.close()
          showToast('Your answer wasn’t saved. Try again.', { icon: 'info' })
          void queryClient.refetchQueries(accountPlayersQuery(api))
        },
      },
    )
  }

  function skip(player: AccountPlayer) {
    setSkipped((ids) => [...ids, player.id])
    setLast(null)
    next()
  }

  const ready = picked !== null && !answer.isPending

  return (
    <>
      {open.length > 0 ? (
        <div className="adopt">
          <Reminder open={open} buttonRef={reviewButton} onReview={openDialog} />
        </div>
      ) : (
        answered && (
          <div className="adopt">
            <p className="fm-notice fm-notice--success" ref={doneNotice} tabIndex={-1}>
              <Icon name="check" />
              <span>You reviewed every player from this device.</span>
            </p>
          </div>
        )
      )}
      <ModalDialog
        ref={dialog}
        className="fm-dialog adopt-review"
        aria-labelledby={titleId}
        onClose={focusHome}
      >
        {last && (
          <p className="fm-notice fm-notice--success" role="status">
            <Icon name="check" />
            <span>{last}</span>
          </p>
        )}
        {current && (
          <>
            <div className="adopt-review__head">
              {total > 1 && (
                <p className="meta">
                  Player {total - queue.length + 1} of {total}
                </p>
              )}
              <h2 id={titleId}>Who is {current.display_name}?</h2>
              <p>This player was used on this device before you signed in.</p>
            </div>
            <PlayerSummary player={current} />
            <fieldset className="adopt-options">
              <legend className="fm-sr">Who is {current.display_name}?</legend>
              {choices.map(({ answer: value, label, description }) => (
                <label key={value} className="fm-radio adopt-option">
                  <input
                    type="radio"
                    name={titleId}
                    value={value}
                    checked={picked === value}
                    onChange={() => setPicked(value)}
                  />
                  <span className="adopt-option__text">
                    <span className="adopt-option__label">{label}</span>
                    <span className="fm-help">{description}</span>
                  </span>
                </label>
              ))}
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
            aria-disabled={ready ? undefined : true}
            busy={answer.isPending}
            onClick={() => current && picked && submit(current, picked)}
          >
            Continue
          </Button>
        </div>
      </ModalDialog>
    </>
  )
}

function PlayerSummary({ player }: { player: AccountPlayer }) {
  return (
    <div className="adopt-player">
      <div className="adopt-player__who">
        <span className="fm-avatar" aria-hidden="true">
          {initials(player.display_name)}
        </span>
        <p className="adopt-player__name">{player.display_name}</p>
      </div>
    </div>
  )
}

function Reminder({
  open,
  buttonRef,
  onReview,
}: {
  open: readonly AccountPlayer[]
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
          ? `${open[0].display_name} was used on this device before you signed in. Choose whether it belongs on your account.`
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
