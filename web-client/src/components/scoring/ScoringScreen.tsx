import { zodResolver } from '@hookform/resolvers/zod'
import { useBlocker } from '@tanstack/react-router'
import {
  useEffect,
  useId,
  useMemo,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react'
import { Controller, useForm, useWatch } from 'react-hook-form'
import { Button } from '../Button.tsx'
import { Icon } from '../Icon.tsx'
import { TextInput } from '../TextInput.tsx'
import {
  gamesWon,
  isDecided,
  mayClear,
  type BestOf,
  type Score,
} from '../../scoring/scoring.ts'
import { ConfirmDialog } from './scoring-screen/ConfirmDialog.tsx'
import { Scoreline, type GameLink } from './scoring-screen/Scoreline.tsx'
import {
  refusalOf,
  refusalPath,
  scoreDefaults,
  scoreSchema,
  type ScoreValues,
} from './ScoringScreen.schema.ts'
import './ScoringScreen.css'

export type { GameLink }

// What the scoring screen takes. Every score is `[yours, theirs]`: this
// device's player first, then the opponent.
export type ScoringScreenProps = {
  // The opponent, by name, on the right of the pad.
  opponentName: string
  bestOf: BestOf
  // The games saved so far, in game order: games[0] is game 1.
  games: readonly Score[]
  // The number of the game on screen, 1 to best of: a saved game (to
  // correct) or the next one (to enter). Which games may be opened is the
  // route's to decide, not the screen's.
  game: number
  // Where a scoreline cell links: the router's link options for game n.
  gameLink: GameLink
  // A valid score for this game, called inside the submit event itself, so
  // the caller can move focus to the next game in the same tap. What
  // happens next (the next game, the dashboard) is the caller's.
  onSave: (game: number, score: Score) => void
  // Clear game n's saved score, once the person has confirmed it. Only the
  // highest saved game is offered.
  onClear: (game: number) => void
}

// The scoring screen (fortymm-real's ScoreEntry): a person types one game's
// final score. A fresh form for each game and each saved score: the caller
// moving on to another game, or a game's score changing under it, opens it
// as it would open from its link.
export function ScoringScreen(props: ScoringScreenProps) {
  const saved = props.games[props.game - 1]
  return (
    <ScoringGame key={`${props.game}:${saved?.join('-') ?? 'new'}`} {...props} />
  )
}

// One game's screen, top to bottom: the heading ("Enter game N score.", or
// "Edit game N score." for a saved game); the score pad, you on the left
// with your field, VS and the games won so far (not for a single game), the
// opponent on the right with theirs; one error line; the action row, what
// saving does, Clear (on the highest saved game) and the submit; then the
// scoreline.
//
// A React Hook Form form whose rules are `scoreSchema` (web-client/
// CLAUDE.md, "Forms"), wrapping the scoring rules. The fields keep digits
// only; Enter or ArrowRight in yours moves to theirs, ArrowLeft back, and a
// field that gets focus selects its score, so typing replaces it. Submit is
// never disabled: an invalid score shows the one error line (the rules'
// reason, or "Enter both scores to save this game."), from the first
// submit on, and saves nothing. The rules' reason is the form's one error,
// marking both fields; "Enter both scores" is each empty field's own.
//
// Leaving with a score typed and not saved (the form not as it opened) asks
// "Leave without saving?", whether by a scoreline cell, any other link or
// the browser's back; closing or reloading the tab asks through the browser.
function ScoringGame({
  opponentName,
  bestOf,
  games,
  game,
  gameLink,
  onSave,
  onClear,
}: ScoringScreenProps) {
  const saved = games[game - 1]
  const editing = saved !== undefined
  const schema = useMemo(
    () => scoreSchema({ bestOf, games, game }),
    [bestOf, games, game],
  )
  const {
    control,
    clearErrors,
    formState: { errors, isDirty, isSubmitted },
    getValues,
    handleSubmit,
    setError,
    setFocus,
  } = useForm<ScoreValues, unknown, Score>({
    resolver: zodResolver(schema),
    defaultValues: scoreDefaults(saved),
  })
  const [yours, theirs] = useWatch({ control, name: ['yours', 'theirs'] })
  const [clearing, setClearing] = useState<number | null>(null)
  const errorId = useId()

  // Your field first, its score selected.
  useEffect(() => {
    setFocus('yours', { shouldSelect: true })
  }, [setFocus])

  // Whether what is typed, saved as this game, would decide the match.
  const typed = schema.safeParse({ yours, theirs })
  const decides =
    typed.success &&
    !isDecided(games, bestOf) &&
    isDecided(editing ? games.with(game - 1, typed.data) : [...games, typed.data], bestOf)

  const [submitLabel, subtitle] = decides
    ? ['Finish match', 'This score finishes the match.']
    : editing
      ? ['Save changes', 'Save updates the score for this game.']
      : bestOf === 1
        ? ['Save game', 'Save this game to finish the match.']
        : game < bestOf
          ? ['Save game & next', `Save this game to continue to game ${game + 1}.`]
          : ['Save final game', 'Final game. Save it to finish the match.']
  const arrow = submitLabel !== 'Finish match' && submitLabel !== 'Save game'

  const [wonByYou, wonByThem] = gamesWon(games)
  // One error line: the refusal of the whole score (the form's error, which
  // marks both fields), or "Enter both scores" on the empty ones.
  const refused = errors.root !== undefined
  const message = errors.root?.message ?? errors.yours?.message ?? errors.theirs?.message

  // React Hook Form re-validates only the field that changed, so a refusal,
  // which is the pair's, is checked again here on each change once
  // submitted: a change that makes the score legal clears it from both
  // fields; one still refused shows the new reason.
  function typedInto(side: 'yours' | 'theirs', value: string) {
    if (!isSubmitted) return
    const reason = refusalOf(schema, { ...getValues(), [side]: value })
    if (reason === undefined) clearErrors(refusalPath)
    else setError(refusalPath, { type: 'custom', message: reason })
  }

  // The one leave guard: the form's own dirty state, against how it opened.
  const blocker = useBlocker({
    shouldBlockFn: () => isDirty,
    enableBeforeUnload: () => isDirty,
    withResolver: true,
  })

  // A valid score is handed on synchronously, inside the submit event, not
  // after React Hook Form's asynchronous validation: a phone keeps its
  // keyboard open only if the next game's field takes focus in the same tap
  // (fortymm-real's score-entry.tsx). An invalid one goes through
  // `handleSubmit`, which shows the errors and focuses the first.
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const result = schema.safeParse(getValues())
    if (result.success) onSave(game, result.data)
    else void handleSubmit(() => {})(event)
  }

  function keyDown(side: 'yours' | 'theirs', event: KeyboardEvent<HTMLInputElement>) {
    const to =
      side === 'yours' && (event.key === 'Enter' || event.key === 'ArrowRight')
        ? 'theirs'
        : side === 'theirs' && event.key === 'ArrowLeft'
          ? 'yours'
          : null
    if (to === null) return
    event.preventDefault()
    setFocus(to, { shouldSelect: true })
  }

  return (
    <>
      <div className="scoring">
        <h1 className="scoring__title">
          {editing ? `Edit game ${game} score.` : `Enter game ${game} score.`}
        </h1>

        <form
          className="scoring__card"
          aria-label={`Game ${game} score`}
          noValidate
          onSubmit={submit}
        >
          <div className="scoring__pad">
            {(['yours', 'theirs'] as const).map((side) => (
              <div key={side} className={`scoring__side scoring__side--${side}`}>
                <span className="scoring__name" aria-hidden="true">
                  {side === 'yours' ? 'You' : opponentName}
                </span>
                <Controller
                  control={control}
                  name={side}
                  render={({ field }) => (
                    <TextInput
                      numeric
                      ref={field.ref}
                      name={field.name}
                      value={field.value}
                      onBlur={field.onBlur}
                      onChange={(event) => {
                        const value = event.target.value.replace(/\D/g, '')
                        field.onChange(value)
                        typedInto(side, value)
                      }}
                      onFocus={selectScore}
                      onMouseDown={focusBeforeCaret}
                      onKeyDown={(event) => keyDown(side, event)}
                      aria-label={
                        side === 'yours' ? 'Your score' : `${opponentName}’s score`
                      }
                      aria-invalid={
                        refused || errors[side] !== undefined ? true : undefined
                      }
                      aria-describedby={message === undefined ? undefined : errorId}
                      inputMode="numeric"
                      autoComplete="off"
                      placeholder="0"
                    />
                  )}
                />
              </div>
            ))}
            <div className="scoring__mid">
              <span className="scoring__vs" aria-hidden="true">
                VS
              </span>
              {bestOf > 1 && (
                <p className="scoring__tally">
                  <span className="visually-hidden">Games won: </span>
                  {wonByYou} – {wonByThem}
                </p>
              )}
            </div>
          </div>

          {message !== undefined && (
            <p id={errorId} className="scoring__error" role="alert">
              <Icon name="circle-alert" />
              {message}
            </p>
          )}

          <div className="scoring__actions">
            <p className="scoring__sub">{subtitle}</p>
            <div className="scoring__buttons">
              {editing && mayClear(games, game) && (
                <Button variant="ghost" size="lg" onClick={() => setClearing(game)}>
                  Clear
                </Button>
              )}
              <Button
                variant="primary"
                size="lg"
                type="submit"
                // A press on Save must not take focus from the field: on a
                // phone that closes the keyboard before the next game opens.
                onMouseDown={(event) => event.preventDefault()}
              >
                {submitLabel}
                {arrow && <Icon name="arrow-right" />}
              </Button>
            </div>
          </div>
        </form>

        <Scoreline
          bestOf={bestOf}
          games={games}
          game={game}
          gameLink={gameLink}
          onClear={setClearing}
        />
      </div>

      {clearing !== null && (
        <ConfirmDialog
          title={`Clear game ${clearing}?`}
          stayLabel="Keep score"
          goLabel="Clear game"
          onStay={() => setClearing(null)}
          onGo={() => {
            setClearing(null)
            onClear(clearing)
          }}
        >
          This deletes the saved score. You can enter it again afterwards.
        </ConfirmDialog>
      )}
      {blocker.status === 'blocked' && (
        <ConfirmDialog
          title="Leave without saving?"
          stayLabel="Keep editing"
          goLabel="Discard & leave"
          onStay={() => blocker.reset()}
          onGo={() => blocker.proceed()}
        >
          You’ve entered a score for this game but haven’t saved it. Leaving now
          discards it.
        </ConfirmDialog>
      )}
    </>
  )
}

// A field that gets focus selects its score, so typing replaces it (the
// user's choice: typing 11 over a saved 11 must not give 1111).
function selectScore(event: { currentTarget: HTMLInputElement }) {
  event.currentTarget.select()
}

// A press into a field that hasn't focus would put the caret where it lands,
// undoing the selection: focus it instead, which selects.
function focusBeforeCaret(event: MouseEvent<HTMLInputElement>) {
  if (document.activeElement === event.currentTarget) return
  event.preventDefault()
  event.currentTarget.focus()
}
