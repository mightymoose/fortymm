import { zodResolver } from '@hookform/resolvers/zod'
import { useBlocker, useRouter } from '@tanstack/react-router'
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react'
import { Controller, useForm, useWatch } from 'react-hook-form'
import type { ActionResult, Failure } from '../../stores/match-source.ts'
import { Button } from '../Button.tsx'
import { DeviceAlert, type NewVersionOffer } from '../DeviceAlert.tsx'
import { Icon } from '../Icon.tsx'
import { opponentLabel } from '../opponent.ts'
import { TextInput } from '../TextInput.tsx'
import {
  gamesWon,
  isDecided,
  savedScore,
  withGame,
  type BestOf,
  type Games,
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
// device's player first, then the opponent, who is "Anonymous" on the right
// of the pad (components/opponent.ts), their field "Opponent’s score".
export type ScoringScreenProps = {
  bestOf: BestOf
  // The match's games, one slot per game number: games[0] is game 1, null
  // for a game not saved (scoring.ts).
  games: Games
  // The number of the game on screen, 1 to best of: a saved game (to
  // correct) or an empty one (to enter), in any order. Which games may be
  // opened is the route's to decide, not the screen's.
  game: number
  // Where a scoreline cell links: the router's link options for game n.
  // Their paths are this match's scoring pages: moving between them never
  // asks to leave.
  gameLink: GameLink
  // A valid score for this game, called inside the submit event itself, so
  // the caller can move focus to the next game in the same tap. What
  // happens next (the next game, the dashboard) is the caller's. Its answer
  // is the store's: one refused shows on the screen.
  onSave: (game: number, score: Score) => Promise<ActionResult>
  // Clear game n's saved score, at once: Clear on a saved game's page, with
  // nothing to confirm. Its answer too.
  onClear: (game: number) => Promise<ActionResult>
  // Whether a new version of the app is waiting, for a save refused because
  // the core didn't load.
  newVersion: NewVersionOffer
}

// The scoring screen (fortymm-real's ScoreEntry): a person types one game's
// final score. A fresh form for each game and each saved score: the caller
// moving on to another game, or a game's score changing under it (a save,
// a clear), opens it as it would open from its link.
export function ScoringScreen(props: ScoringScreenProps) {
  const saved = savedScore(props.games, props.game)
  return (
    <ScoringGame key={`${props.game}:${saved?.join('-') ?? 'new'}`} {...props} />
  )
}

// One game's screen, top to bottom: the heading ("Enter game N score.", or
// "Edit game N score." for a saved game); the score pad, you on the left
// with your field, VS and the games won so far (not for a single game), the
// opponent on the right with theirs; one error line; the action row, what
// saving does, Clear (on a saved game only) and the submit; then the
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
// Clear empties a saved game at once, with nothing to confirm, and the
// screen stays on that game, its fields empty. No other action asks.
//
// A save or a clear the device refused (its storage, its locks, signing, or
// the core not loaded) keeps what is typed and shows an error alert where
// the error line goes, read out at once ("That wasn't saved.", DeviceAlert).
// It stays while the person types, and goes the moment Save or Clear is
// pressed again; a refusal again shows it anew. Opening another game drops
// it. A move to another game while a save or a clear is on its way waits
// for the answer, and is dropped if it was refused. When it offers the new
// version's Reload after a save, it says the
// typed score will need typing again, and that reload doesn't ask to leave.
// A save the store's rules refused after the screen allowed it (the match
// changed meanwhile) shows its message in the error line.
//
// Leaving scoring altogether with a score typed and not saved (the form not
// as it opened) asks "Leave without saving?": by any link or the browser's
// back to a page that isn't one of this match's games; closing or reloading
// the tab asks through the browser. Moving to another of the match's games
// (a scoreline cell, the browser's back to one) never asks: what was typed
// is dropped.
function ScoringGame({
  bestOf,
  games,
  game,
  gameLink,
  onSave,
  onClear,
  newVersion,
}: ScoringScreenProps) {
  const saved = savedScore(games, game)
  const editing = saved !== null
  const router = useRouter()
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
  const errorId = useId()
  // What the device refused of the last save or clear, if it did.
  const [deviceRefusal, setDeviceRefusal] = useState<Failure['reason'] | null>(null)
  // Whether a save or a clear is on its way.
  const [pending, setPending] = useState(false)
  // Set once the person asked for the new version: that reload doesn't ask.
  const reloading = useRef(false)
  // What the new version's reload would drop: the score typed now and not
  // saved, if both fields have one.
  const lost =
    isDirty && yours !== '' && theirs !== ''
      ? `Reloading clears ${yours}–${theirs}; you’ll type it again.`
      : undefined

  // The store's answer to a save or a clear: a device refusal is the alert;
  // a rules refusal, the error line.
  function answered(result: ActionResult) {
    setPending(false)
    if (result.ok) return
    if ('message' in result) {
      setError(refusalPath, { type: 'custom', message: result.message })
    } else {
      setDeviceRefusal(result.reason)
    }
  }

  // Your field first, its score selected.
  useEffect(() => {
    setFocus('yours', { shouldSelect: true })
  }, [setFocus])

  // Whether what is typed, saved as this game, would decide the match.
  const typed = schema.safeParse({ yours, theirs })
  const decides =
    typed.success &&
    !isDecided(games, bestOf) &&
    isDecided(withGame(games, game, typed.data), bestOf)
  // The game a save of this empty one moves on to, when it doesn't decide
  // the match: the lowest other empty game (none: this is the last one left).
  const following = Array.from({ length: bestOf }, (_, index) => index + 1).find(
    (n) => n !== game && savedScore(games, n) === null,
  )

  const [submitLabel, subtitle] = decides
    ? ['Finish match', 'This score finishes the match.']
    : editing
      ? ['Save changes', 'Save updates the score for this game.']
      : bestOf === 1
        ? ['Save game', 'Save this game to finish the match.']
        : following !== undefined
          ? ['Save game & next', `Save this game to continue to game ${following}.`]
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

  // Whether `pathname` is one of the match's games' pages (a path `gameLink`
  // gives).
  const isGamePage = (pathname: string) =>
    Array.from({ length: bestOf }, (_, index) => index + 1).some(
      (n) => router.buildLocation(gameLink(n)).pathname === pathname,
    )

  // The one leave guard: the form's own dirty state, against how it opened,
  // for a move out of scoring; a move to one of the match's games drops what
  // is typed and asks nothing. While a save or a clear is on its way, a move
  // to another game waits for its answer, asking nothing (the user's choice,
  // 2026-11-16): one that works moves on as it does; one refused stays, and
  // the move is dropped (the effect below).
  const blocker = useBlocker({
    shouldBlockFn: ({ next }) => (isGamePage(next.pathname) ? pending : isDirty),
    enableBeforeUnload: () => isDirty && !reloading.current,
    withResolver: true,
  })
  const heldMove = blocker.status === 'blocked' && isGamePage(blocker.next.pathname)
  useEffect(() => {
    if (heldMove && !pending) blocker.reset?.()
  }, [heldMove, pending, blocker])

  // A valid score is handed on synchronously, inside the submit event, not
  // after React Hook Form's asynchronous validation: a phone keeps its
  // keyboard open only if the next game's field takes focus in the same tap
  // (fortymm-real's score-entry.tsx). An invalid one goes through
  // `handleSubmit`, which shows the errors and focuses the first. Pressing
  // Save takes away what the last answer showed.
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const result = schema.safeParse(getValues())
    if (result.success) {
      const saving = onSave(game, result.data)
      setPending(true)
      setDeviceRefusal(null)
      clearErrors(refusalPath)
      void saving.then(answered)
    } else void handleSubmit(() => {})(event)
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
                  {side === 'yours' ? 'You' : opponentLabel}
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
                        side === 'yours' ? 'Your score' : 'Opponent’s score'
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

          {deviceRefusal !== null && (
            <div className="scoring__refused">
              <DeviceAlert
                title="That wasn’t saved."
                refusal={{ action: 'write', reason: deviceRefusal }}
                newVersion={newVersion}
                lost={lost}
                onReload={() => {
                  reloading.current = true
                }}
              />
            </div>
          )}

          <div className="scoring__actions">
            <p className="scoring__sub">{subtitle}</p>
            <div className="scoring__buttons">
              {editing && (
                <Button
                  variant="ghost"
                  size="lg"
                  onClick={() => {
                    const clearing = onClear(game)
                    setPending(true)
                    setDeviceRefusal(null)
                    clearErrors(refusalPath)
                    void clearing.then(answered)
                  }}
                >
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

        <Scoreline bestOf={bestOf} games={games} game={game} gameLink={gameLink} />
      </div>

      {blocker.status === 'blocked' && !heldMove && (
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
