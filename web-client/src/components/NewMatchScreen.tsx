import { useBlocker } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'
import { initials } from '../initials.ts'
import { Avatar } from './Avatar.tsx'
import { BestOfField, type BestOf } from './BestOfField.tsx'
import { Button } from './Button.tsx'
import { ButtonLink } from './ButtonLink.tsx'
import { DiscardChangesDialog } from './DiscardChangesDialog.tsx'
import { Field } from './Field.tsx'
import { Icon } from './Icon.tsx'
import { RatedField } from './RatedField.tsx'
import { TextInput } from './TextInput.tsx'
import './NewMatchScreen.css'

// What the form gives its handler: the opponent's name as typed, trimmed;
// the match's format, as the plan's match descriptor names it (`format:
// {bestOf, points}`; every game is to 11); and whether it is rated.
export type NewMatch = {
  opponentName: string
  format: { bestOf: BestOf; points: 11 }
  rated: boolean
}

// The form as it opens. Anything else is a change that leaving would lose.
const defaultBestOf: BestOf = 5
const defaultRated = false

const opponentRequired = 'Enter your opponent’s name.'

// The new match screen, at /matches/new, after fortymm-real's match setup:
// the title, then one card. In it: who you are (this device's user, `you`,
// when there is one), the opponent, the match's length and whether it is
// rated (side by side where the card is wide enough), then a summary of
// the match with Cancel and Start match.
//
// Start match hands what was entered to `onSubmit`. The opponent's name is
// required: without one, it shows the field's error, moves focus to it and
// calls nothing; once a submit has failed, the error follows what is typed.
// Rated needs an opponent: with no name it is off and unavailable, and
// clearing the name turns it off.
//
// Leaving a changed form (a name typed, the length or rated changed) asks
// first, "Discard changes?", whether by Cancel, any other link, or the
// browser's back; closing or reloading the tab asks through the browser.
// It renders in the layout's <main> (AppLayout).
export function NewMatchScreen({
  you,
  onSubmit,
}: {
  you: { username: string } | null
  onSubmit: (match: NewMatch) => void
}) {
  const [opponentName, setOpponentName] = useState('')
  const [bestOf, setBestOf] = useState<BestOf>(defaultBestOf)
  const [rated, setRated] = useState(defaultRated)
  const [triedSubmit, setTriedSubmit] = useState(false)

  const name = opponentName.trim()
  const ratable = name !== ''
  const isRated = rated && ratable
  const opponentError =
    triedSubmit && name === '' ? opponentRequired : undefined
  const dirty =
    opponentName !== '' || bestOf !== defaultBestOf || rated !== defaultRated

  const blocker = useBlocker({
    shouldBlockFn: () => dirty,
    enableBeforeUnload: () => dirty,
    withResolver: true,
  })

  function changeName(value: string) {
    setOpponentName(value)
    // No opponent, no rating: a rated match whose opponent is cleared is
    // not rated again when another name is typed.
    if (value.trim() === '') setRated(false)
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setTriedSubmit(true)
    if (name === '') {
      const opponent = event.currentTarget.elements.namedItem('opponent')
      if (opponent instanceof HTMLInputElement) opponent.focus()
      return
    }
    onSubmit({
      opponentName: name,
      format: { bestOf, points: 11 },
      rated: isRated,
    })
  }

  return (
    <>
    <div className="new-match">
      <h1 className="new-match__title">
        New match
        <span className="new-match__dot" aria-hidden="true">
          .
        </span>
      </h1>

      <form
        className="new-match__card"
        aria-label="New match"
        noValidate
        onSubmit={submit}
      >
        <div className="new-match__you">
          <Avatar initials={you === null ? '' : initials(you.username)} />
          <div className="new-match__you-text">
            <span className="new-match__overline">You</span>
            {you !== null && (
              <span className="new-match__you-name">{you.username}</span>
            )}
          </div>
        </div>

        <div className="new-match__opponent">
          <Field
            label="Opponent"
            help="Their name, as you’d call them."
            error={opponentError}
          >
            {(control) => (
              <TextInput
                {...control}
                name="opponent"
                autoComplete="off"
                autoCapitalize="words"
                required
                value={opponentName}
                onChange={(event) => changeName(event.target.value)}
              />
            )}
          </Field>
        </div>

        <div className="new-match__settings">
          <BestOfField bestOf={bestOf} onChange={setBestOf} />
          <RatedField rated={rated} ratable={ratable} onChange={setRated} />
        </div>

        <div className="new-match__summary">
          <div className="new-match__read">
            <p className="new-match__headline">
              {ratable ? (
                <>
                  Ready: <b>You</b> vs <b>{name}</b>
                </>
              ) : (
                <span className="new-match__tbd">
                  Name your opponent to start
                </span>
              )}
            </p>
            <p className="new-match__sub">
              {bestOf === 1
                ? 'Single game'
                : `Best of ${bestOf} · first to ${Math.ceil(bestOf / 2)}`}
              {' · '}
              {isRated ? (
                <span className="new-match__rated">Rated</span>
              ) : (
                'Unrated'
              )}
              {' · games to 11, win by 2'}
            </p>
          </div>
          <div className="new-match__actions">
            <ButtonLink to="/" variant="secondary" size="lg">
              Cancel
            </ButtonLink>
            <Button variant="primary" size="lg" type="submit">
              Start match
              <Icon name="arrow-right" />
            </Button>
          </div>
        </div>
      </form>
    </div>
    {/* Outside the page's box, so nothing of the page's layout reaches it:
        it covers the whole screen. */}
    {blocker.status === 'blocked' && (
      <DiscardChangesDialog
        onLeave={() => blocker.proceed()}
        onStay={() => blocker.reset()}
      />
    )}
    </>
  )
}
