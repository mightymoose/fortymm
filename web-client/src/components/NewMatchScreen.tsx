import { useState, type FormEvent } from 'react'
import { Breadcrumbs } from './Breadcrumbs.tsx'
import { Button } from './Button.tsx'
import { ButtonLink } from './ButtonLink.tsx'
import { Field } from './Field.tsx'
import { SegmentedControl } from './SegmentedControl.tsx'
import { TextInput } from './TextInput.tsx'
import './NewMatchScreen.css'

// How long a match is: the most games it can take. The winner is first to
// more than half of them.
const bestOfOptions = [1, 3, 5, 7] as const
export type BestOf = (typeof bestOfOptions)[number]

// The points a game is played to, won by 2.
const pointsOptions = [11, 21] as const
export type Points = (typeof pointsOptions)[number]

// What the form gives its handler: the opponent's name as typed, trimmed,
// and the match's format, as the plan's match descriptor names it
// (`format: {bestOf, points}`).
export type NewMatch = {
  opponentName: string
  format: { bestOf: BestOf; points: Points }
}

const defaultBestOf: BestOf = 5
const defaultPoints: Points = 11

const opponentRequired = 'Enter your opponent’s name.'

function gamesToWin(bestOf: BestOf) {
  return Math.ceil(bestOf / 2)
}

function lengthHelp(bestOf: BestOf) {
  return bestOf === 1
    ? 'One game, winner takes all.'
    : `First to ${gamesToWin(bestOf)} games.`
}

// The new match screen, at /matches/new: the opponent and the match's
// format (its length, best of 1, 3, 5 or 7, and the points a game is played
// to), then Start match, which hands what was entered to `onSubmit`, or
// Cancel, back to the dashboard. The opponent's name is required: submitting
// without one shows the field's error, moves focus to it and calls nothing.
// Once a submit has failed, the error follows what is typed.
//
// A form for a match between this device's player and one other, after
// fortymm-real's setup screen; the opponent is a typed name until players
// can be looked up. It renders in the layout's <main> (AppLayout).
export function NewMatchScreen({
  onSubmit,
}: {
  onSubmit: (match: NewMatch) => void
}) {
  const [opponentName, setOpponentName] = useState('')
  const [bestOf, setBestOf] = useState<BestOf>(defaultBestOf)
  const [points, setPoints] = useState<Points>(defaultPoints)
  const [triedSubmit, setTriedSubmit] = useState(false)

  const name = opponentName.trim()
  const opponentError =
    triedSubmit && name === '' ? opponentRequired : undefined

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setTriedSubmit(true)
    if (name === '') {
      const opponent = event.currentTarget.elements.namedItem('opponent')
      if (opponent instanceof HTMLInputElement) opponent.focus()
      return
    }
    onSubmit({ opponentName: name, format: { bestOf, points } })
  }

  return (
    <div className="new-match">
      <Breadcrumbs trail={[{ label: 'Dashboard', href: '/' }]} current="New match" />
      <h1>New match</h1>

      <form
        className="new-match__form"
        aria-label="New match"
        noValidate
        onSubmit={submit}
      >
        <section className="new-match__section" aria-labelledby="new-match-players">
          <h2 id="new-match-players" className="new-match__section-title">
            Players
          </h2>
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
                onChange={(event) => setOpponentName(event.target.value)}
              />
            )}
          </Field>
        </section>

        <section className="new-match__section" aria-labelledby="new-match-format">
          <h2 id="new-match-format" className="new-match__section-title">
            Format
          </h2>
          <div className="new-match__choice">
            {/* The radiogroup is named "Best of" itself; this is that name,
                shown. */}
            <span className="field__label" aria-hidden="true">
              Best of
            </span>
            <SegmentedControl
              label="Best of"
              options={bestOfOptions.map((n) => ({
                value: String(n),
                label: String(n),
              }))}
              defaultValue={String(defaultBestOf)}
              onChange={(value) => setBestOf(Number(value) as BestOf)}
            />
            <p className="field__help">{lengthHelp(bestOf)}</p>
          </div>
          <div className="new-match__choice">
            <span className="field__label" aria-hidden="true">
              Points per game
            </span>
            <SegmentedControl
              label="Points per game"
              options={pointsOptions.map((n) => ({
                value: String(n),
                label: String(n),
              }))}
              defaultValue={String(defaultPoints)}
              onChange={(value) => setPoints(Number(value) as Points)}
            />
            <p className="field__help">Win each game by 2.</p>
          </div>
        </section>

        <div className="new-match__summary">
          <p className="new-match__summary-line">
            {name === '' ? (
              'You vs your opponent'
            ) : (
              <>
                You vs <b>{name}</b>
              </>
            )}
          </p>
          <p className="field__help">
            {bestOf === 1 ? 'Single game' : `Best of ${bestOf}`} · games to{' '}
            {points}
          </p>
        </div>

        <div className="new-match__actions">
          <Button variant="primary" size="lg" type="submit">
            Start match
          </Button>
          <ButtonLink to="/" variant="ghost" size="lg">
            Cancel
          </ButtonLink>
        </div>
      </form>
    </div>
  )
}
