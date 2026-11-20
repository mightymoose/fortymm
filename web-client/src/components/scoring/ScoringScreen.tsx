import { zodResolver } from '@hookform/resolvers/zod'
import { useBlocker, useRouter, type LinkOptions } from '@tanstack/react-router'
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
  decidingGame,
  gamesWon,
  isDecided,
  pastDecider,
  savedScore,
  withGame,
  type BestOf,
  type Games,
  type Score,
} from '../../scoring/scoring.ts'
import { ConfirmDialog } from './scoring-screen/ConfirmDialog.tsx'
import { hasKeys, takeKeys } from '../type-ahead.ts'
import { FinishedElsewhere } from './scoring-screen/FinishedElsewhere.tsx'
import { Scoreline, type GameLink, type Updates } from './scoring-screen/Scoreline.tsx'
import {
  refusalOf,
  refusalPath,
  scoreDefaults,
  scoreSchema,
  type ScoreValues,
} from './ScoringScreen.schema.ts'
import './ScoringScreen.css'

export type { GameLink, Updates }

// What the scoring screen takes. Every score is `[yours, theirs]`: this
// device's player first, then the opponent, who is "Anonymous" on the right
// of the pad (components/opponent.ts), their field "Opponent’s score".
export type ScoringScreenProps = {
  bestOf: BestOf
  // The match's games as they are kept, one slot per game number: games[0]
  // is game 1, null for a game not saved (scoring.ts). They change while the
  // screen is open (another tab, later a sync pull): the screen shows them
  // at once and marks what changed.
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
  // the caller can move focus to the next game in the same tap. Its answer
  // is the store's: one refused shows on the screen.
  onSave: (game: number, score: Score) => Promise<ActionResult>
  // A save worked and the person moves on from it: where to (the next game,
  // the dashboard) is the caller's. Not called when the person left while
  // the save was on its way: they go where they went.
  onSaved: () => void
  // Clear game n's saved score, at once: Clear on a saved game's page, with
  // nothing to confirm. Its answer too.
  onClear: (game: number) => Promise<ActionResult>
  // Whether a new version of the app is waiting, for a save refused because
  // the core didn't load.
  newVersion: NewVersionOffer
  // The match's page: where the notice for an empty game of a match finished
  // elsewhere sends the person.
  matchPage: LinkOptions
}

// The scoring screen (fortymm-real's ScoreEntry): a person types one game's
// final score. A fresh form for each game: the caller moving on to another
// game opens it as it would open from its link. A new score for this game
// (another tab's, or this page's own clear) reaches the same form, in place.
//
// What outlives one game's form, for the match's scoring pages
// (`Background`): a clear goes on in the background when the person moves
// to another game (the user's decision, 2026-11-20), so the page knows it is
// on its way, that it is no change made elsewhere, and how it answered.
export function ScoringScreen(props: ScoringScreenProps) {
  const own = useRef(new Map<number, Score | null>())
  const clearing = useRef<number | null>(null)
  const [clearingGame, setClearingGame] = useState<number | null>(null)
  const worked = useRef(false)
  const [clearRefused, setClearRefused] = useState<ClearRefused | null>(null)
  // A refusal shown on one game's page goes when another game opens.
  const [openGame, setOpenGame] = useState(props.game)
  if (openGame !== props.game) {
    setOpenGame(props.game)
    setClearRefused(null)
  }
  const background: Background = {
    isOwn: (n, score) => own.current.has(n) && scoreText(own.current.get(n) ?? null) === scoreText(score),
    sending(n, score) {
      own.current.set(n, score)
      if (score !== null) return
      clearing.current = n
      setClearingGame(n)
    },
    answered(n, ok) {
      own.current.delete(n)
      worked.current = ok
      if (clearing.current !== n) return
      clearing.current = null
      setClearingGame(null)
    },
    clearing: () => clearing.current,
    clearingGame,
    worked: () => worked.current,
    clearRefused,
    setClearRefused,
  }
  return <ScoringGame key={props.game} {...props} background={background} />
}

// A clear the device refused once the person had moved to another game:
// which game, why, and the score it still has.
type ClearRefused = { game: number; reason: Failure['reason']; saved: Score | null }

type Background = {
  // Whether game n becoming `score` is this page's own save or clear, still
  // on its way: no change made elsewhere.
  isOwn: (n: number, score: Score | null) => boolean
  // A save or a clear (`score` null) of game n handed to the store, and its
  // answer. A clear is marked on its way, in the press itself.
  sending: (n: number, score: Score | null) => void
  answered: (n: number, ok: boolean) => void
  // The game whose clear is on its way, if one is: at once, for the leave
  // guard; `clearingGame` is the same, for what is drawn.
  clearing: () => number | null
  clearingGame: number | null
  // Whether the last save or clear answered that it worked.
  worked: () => boolean
  clearRefused: ClearRefused | null
  setClearRefused: (refused: ClearRefused | null) => void
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
// field that gets focus selects its score, so typing replaces it. Enter in
// theirs saves, so a phone's keyboard, which covers Save, saves from its
// action key, labelled Next in yours and Go in theirs (`enterKeyHint`; an
// iPhone's number pad has no action key). Submit is
// off only while a save or a clear is on its way (Clear too), and when the
// match was finished elsewhere; an invalid score never turns it off: it
// shows the one error line (the rules' reason, or "Enter both scores to save
// this game."), from the first submit on, and saves nothing. The rules'
// reason is the form's one error, marking both fields; "Enter both scores"
// is each empty field's own.
//
// Clear empties a saved game at once, with nothing to confirm, and the
// screen stays on that game, its fields empty. A tap on another game while
// it is on its way opens that game at once, and the clear goes on in the
// background (the user's decision, 2026-11-20). No other action asks.
//
// A save or a clear the device refused (its storage, its locks, signing, or
// the core not loaded) keeps what is typed and shows an error alert where
// the error line goes, read out at once (DeviceAlert: what failed, what we know, what to do).
// It stays while the person types, and goes the moment Save or Clear is
// pressed again; a refusal again shows it anew. Opening another game drops
// it. A clear refused after the person moved to another game shows on that
// game's page, the same way. A move while a save is on its way (to another
// game, or out of scoring), or out of scoring while a clear is, waits for
// the answer, asking nothing, and is dropped if it was refused. When it
// offers the new version's Reload after a save, it says the typed score
// will need typing again, and that reload doesn't ask to leave. A save the
// store's rules refused after the screen allowed it (the match changed
// meanwhile) shows its message in the error line.
//
// A move with a score typed and not saved (the form not as the game is
// kept) asks "Leave without saving?": by any link or the browser's back,
// out of scoring or to another of the match's games (but while this game's
// clear is on its way, which empties what is typed); closing or reloading
// the tab asks through the browser.
//
// The games are live (the user's rule: "we can change things in the
// background as long as theres some notification that it happened"). When
// they change elsewhere (another tab, later a sync pull), the heading, the
// tally, what Save says, whether Clear shows and the scoreline follow at
// once, and the scoreline tints the games that changed and reads them out
// ("Game 2 updated.", Scoreline.tsx). Fields nobody has typed in follow
// this game's kept score, in place: the same inputs, so focus and a phone's
// keyboard stay. Once either field is typed in, both keep what is typed
// (approved default 1), and Save overwrites whatever is kept (default 3).
// This page's own save or clear is no change to mark: the page remembers it
// while it is on its way, and forgets it when the store answers.
//
// An empty game of a match that is now decided (finished elsewhere) can't
// be played: a warning notice under the heading says so, with a link to the
// match's page (FinishedElsewhere.tsx), and Save is off; what is typed
// stays (approved default 2: only for an empty game; a saved game of a
// decided match is still corrected as ever).
function ScoringGame({
  bestOf,
  games,
  game,
  gameLink,
  onSave,
  onSaved,
  onClear,
  newVersion,
  matchPage,
  background,
}: ScoringScreenProps & { background: Background }) {
  const { isOwn, clearing, clearingGame, worked, clearRefused, setClearRefused } = background
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
    reset,
    setValue,
    setError,
    setFocus,
  } = useForm<ScoreValues, unknown, Score>({
    resolver: zodResolver(schema),
    defaultValues: scoreDefaults(saved),
  })
  const [yours, theirs] = useWatch({ control, name: ['yours', 'theirs'] })
  const errorId = useId()
  const formId = useId()
  // The game that decided the match, if it is decided. An empty game after
  // it can't be played (the finished notice); one before it was played, and
  // takes its score (a game cleared by mistake).
  const decider = decidingGame(games, bestOf)
  const finished = saved === null && pastDecider(games, bestOf, game)
  // Whether either field has been typed in: then both keep what is typed.
  const touched = useRef(false)
  // The games that changed elsewhere in the latest change, for the
  // scoreline's tint and read-out; `change` counts the changes.
  const [updates, setUpdates] = useState<Updates>({ games: [], change: 0 })
  const shown = useRef(games)
  useEffect(() => {
    const was = shown.current
    shown.current = games
    if (was === games) return
    const changed = Array.from({ length: bestOf }, (_, index) => index + 1).filter(
      (n) =>
        scoreText(savedScore(was, n)) !== scoreText(savedScore(games, n)) &&
        !isOwn(n, savedScore(games, n)),
    )
    if (changed.length > 0) setUpdates((last) => ({ games: changed, change: last.change + 1 }))
  }, [games, bestOf, isOwn])
  // Untouched fields follow this game's kept score, in place. Fields typed
  // in keep what is typed, now measured against the score kept now: the
  // form is dirty (leaving asks) when what is typed isn't kept.
  const savedText = scoreText(saved)
  const followed = useRef(savedText)
  useEffect(() => {
    if (followed.current === savedText) return
    followed.current = savedText
    if (!touched.current) reset(scoreDefaults(saved))
    else
      reset(scoreDefaults(saved), {
        keepValues: true,
        keepErrors: true,
        keepIsSubmitted: true,
        keepSubmitCount: true,
        keepTouched: true,
      })
  }, [savedText, saved, reset])
  // What the device refused of the last save or clear, if it did.
  const [deviceRefusal, setDeviceRefusal] = useState<{
    action: 'save' | 'clear'
    reason: Failure['reason']
  } | null>(null)
  // Which of the two is on its way, for its refusal.
  const acting = useRef<'save' | 'clear'>('save')
  // Whether a save or a clear is on its way: Save and Clear are off until
  // the store answers (the user's decision, 2026-11-18), so one press keeps
  // one signed record. `busy` says the same, set in the press itself, so a
  // second press or Enter before React draws the first ignores itself. A
  // clear of this game still on its way from an earlier visit counts too.
  const [sending, setSending] = useState(false)
  const pending = sending || clearingGame === game
  const busy = useRef(false)
  // The score field that last had focus: staying on the page after "Leave
  // without saving?" puts focus back there (black-box #17).
  const lastField = useRef<'yours' | 'theirs'>('yours')
  // Set once the person asked for the new version: that reload doesn't ask.
  const reloading = useRef(false)

  // A move held while a save or a clear is on its way (the leave guard,
  // below): to another of the match's games, or out of scoring.
  const holding = useRef<'game' | 'leave' | null>(null)
  // Whether this game's page is still the one shown: a clear that answers
  // after the person moved on is answered by the page they are on.
  const shownNow = useRef(true)
  useEffect(() => {
    shownNow.current = true
    return () => {
      shownNow.current = false
    }
  }, [])

  // The store's answer to a save or a clear: a save that worked moves on
  // (the caller's), unless the person is leaving scoring; a device refusal
  // is the alert; a rules refusal, the error line. A clear refused after
  // the person moved to another game shows on that game's page (a device
  // refusal; a rules one, "Game N isn’t saved", means it is already empty,
  // as asked).
  function answered(result: ActionResult) {
    busy.current = false
    background.answered(game, result.ok)
    setSending(false)
    if (result.ok) {
      if (acting.current === 'save' && holding.current !== 'leave') onSaved()
      return
    }
    if ('message' in result) {
      setError(refusalPath, { type: 'custom', message: result.message })
    } else if (shownNow.current || acting.current === 'save') {
      setDeviceRefusal({ action: acting.current, reason: result.reason })
    } else {
      setClearRefused({ game, reason: result.reason, saved })
    }
  }

  // Your field first, its score selected; again after this page's own clear
  // (`cleared` counts them), once its empty fields are drawn.
  const [cleared, setCleared] = useState(0)
  // The field keys typed before the page opened ended in, once typed (below):
  // kept, so an effect run again (React's StrictMode, in development)
  // places focus again.
  const typedAhead = useRef<'yours' | 'theirs' | null>(null)
  useEffect(() => {
    // Keys typed before the page opened place focus themselves (below).
    if (hasKeys() || typedAhead.current !== null) return
    setFocus('yours', { shouldSelect: true })
  }, [setFocus, cleared])

  // Keys typed before the page opened (straight after Start match,
  // type-ahead.ts), typed into the fields as the fields themselves would
  // take them: digits into the field, Enter, Tab or ArrowRight from yours to
  // theirs. A second Enter would be a save: it, and what follows, is
  // dropped. Typing goes on where they left off: once the typed keys are
  // drawn (the next task), focus is in the field they ended in, the caret
  // after them (a field selects its score on focus, which the next key
  // would replace, so that one focus doesn't select).
  // The score inputs themselves, to focus one without its selecting.
  const inputs = useRef<Record<'yours' | 'theirs', HTMLInputElement | null>>({
    yours: null,
    theirs: null,
  })
  const keepCaret = useRef(false)
  useEffect(() => {
    const keys = takeKeys()
    if (keys.length > 0) {
      let ended: 'yours' | 'theirs' = 'yours'
      const typed = { yours: '', theirs: '' }
      for (const key of keys) {
        if (/^[0-9]$/.test(key)) typed[ended] += key
        else if (ended === 'yours') ended = 'theirs'
        else break
      }
      touched.current = true
      for (const field of ['yours', 'theirs'] as const) {
        if (typed[field] !== '') setValue(field, typed[field], { shouldDirty: true })
      }
      typedAhead.current = ended
    }
    const side = typedAhead.current
    if (side === null) return
    const placed = setTimeout(() => {
      const input = inputs.current[side]
      if (!input) return
      keepCaret.current = true
      input.focus()
      keepCaret.current = false
      input.setSelectionRange(input.value.length, input.value.length)
    }, 0)
    return () => clearTimeout(placed)
  }, [setValue])

  // Whether what is typed, saved as this game, would decide the match.
  const typed = schema.safeParse({ yours, theirs })
  const decides =
    typed.success &&
    decider === null &&
    isDecided(withGame(games, game, typed.data), bestOf)
  // The game a save of this empty one moves on to, when it doesn't decide
  // the match: the lowest other empty game (none: this is the last one left).
  const following = Array.from({ length: bestOf }, (_, index) => index + 1).find(
    (n) => n !== game && savedScore(games, n) === null,
  )

  const [submitLabel, subtitle] = finished
    ? ['Save game', 'The match is finished.']
    : decides
    ? ['Finish match', 'This score finishes the match.']
    : editing
      ? ['Save changes', 'Save updates the score for this game.']
      : decider !== null
      ? // An empty game before the decider: a save leaves the match decided.
        ['Save game', `The match was decided in game ${decider}; this game was played before it.`]
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
  // fields; one still refused shows the new reason. So it is when the games
  // change (below).
  function typedInto(side: 'yours' | 'theirs', value: string) {
    if (!isSubmitted) return
    const reason = refusalOf(schema, { ...getValues(), [side]: value })
    if (reason === undefined) clearErrors(refusalPath)
    else setError(refusalPath, { type: 'custom', message: reason })
  }
  // The games changing elsewhere can make the typed score legal, or refuse
  // it anew: once submitted, its refusal is checked again then too.
  const checkedFor = useRef(schema)
  useEffect(() => {
    if (checkedFor.current === schema) return
    checkedFor.current = schema
    if (!isSubmitted) return
    const reason = refusalOf(schema, getValues())
    if (reason === undefined) clearErrors(refusalPath)
    else setError(refusalPath, { type: 'custom', message: reason })
  }, [schema, isSubmitted, getValues, clearErrors, setError])

  // Whether `pathname` is one of the match's games' pages (a path `gameLink`
  // gives).
  const isGamePage = (pathname: string) =>
    Array.from({ length: bestOf }, (_, index) => index + 1).some(
      (n) => router.buildLocation(gameLink(n)).pathname === pathname,
    )

  // The one leave guard: the form's own dirty state, against how it opened.
  // A move with a score typed and not saved asks "Leave without saving?",
  // whether it leaves scoring or goes to another of the match's games
  // (black-box #8, approved 2026-11-18). While a save is on its way, any
  // move waits for its answer, asking nothing: a move to another game (the
  // user's choice, 2026-11-16), and leaving scoring (round 4: the score is
  // being kept, so "Leaving now discards it" would be untrue). While a clear
  // is (this game's, or one going on in the background), a move to another
  // game goes at once (the user's decision, 2026-11-20), and asks nothing
  // when the clear is this game's, which empties what is typed; leaving
  // scoring waits, asking nothing, so a refusal still has a page to show on.
  // Once it answers (the effect below): one that worked moves on as it
  // does, but a way out of scoring goes where the person went; one refused
  // stays, and the move is dropped. `held` says the blocked move is such a
  // wait, not a question.
  const [held, setHeld] = useState(false)
  const blocker = useBlocker({
    shouldBlockFn: ({ next }) => {
      const toGame = isGamePage(next.pathname)
      const saving = busy.current && acting.current === 'save'
      const waits = saving || (clearing() !== null && !toGame)
      holding.current = waits ? (toGame ? 'game' : 'leave') : null
      setHeld(waits)
      return waits || (isDirty && !(toGame && clearing() === game))
    },
    enableBeforeUnload: () => isDirty && !reloading.current,
    withResolver: true,
  })
  const heldMove = blocker.status === 'blocked' && held
  const waiting = sending || clearingGame !== null
  useEffect(() => {
    if (!heldMove || waiting) return
    if (worked() && holding.current === 'leave') blocker.proceed?.()
    else blocker.reset?.()
    holding.current = null
  }, [heldMove, waiting, blocker, worked])

  // A valid score is handed on synchronously, inside the submit event, not
  // after React Hook Form's asynchronous validation: a phone keeps its
  // keyboard open only if the next game's field takes focus in the same tap
  // (fortymm-real's score-entry.tsx). An invalid one goes through
  // `handleSubmit`, which shows the errors and focuses the first. Pressing
  // Save takes away what the last answer showed. A submit while a save or a
  // clear is on its way, or for a game that can't be played, does nothing.
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy.current || clearing() === game || finished) return
    const result = schema.safeParse(getValues())
    if (result.success) {
      const score = result.data
      send(score, () => onSave(game, score))
    } else void handleSubmit(() => {})(event)
  }

  // Clear: once kept, the fields are empty, whatever was typed, and your
  // field has focus (Clear itself is gone with the saved score).
  function clear() {
    send(null, async () => {
      const result = await onClear(game)
      if (result.ok) {
        touched.current = false
        reset(scoreDefaults(null))
        setCleared((count) => count + 1)
      }
      return result
    })
  }

  // Hands a save or a clear (`score` null) of this game to the store, unless
  // one is on its way, and waits for its answer. A clear is marked on its
  // way for the match's pages, in the press itself.
  function send(score: Score | null, action: () => Promise<ActionResult>) {
    if (busy.current || clearing() === game) return
    busy.current = true
    background.sending(game, score)
    acting.current = score === null ? 'clear' : 'save'
    const answer = action()
    setSending(true)
    setDeviceRefusal(null)
    setClearRefused(null)
    clearErrors(refusalPath)
    void answer.then(answered)
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

        <div className="scoring__elsewhere" role="status">
          {finished && <FinishedElsewhere game={game} matchPage={matchPage} />}
        </div>

        <form
          id={formId}
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
                      ref={(input) => {
                        field.ref(input)
                        inputs.current[side] = input
                      }}
                      name={field.name}
                      value={field.value}
                      onBlur={field.onBlur}
                      onChange={(event) => {
                        const value = event.target.value.replace(/\D/g, '')
                        touched.current = true
                        field.onChange(value)
                        typedInto(side, value)
                      }}
                      onFocus={(event) => {
                        lastField.current = side
                        if (!keepCaret.current) selectScore(event)
                      }}
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
                      enterKeyHint={side === 'yours' ? 'next' : 'go'}
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
                refusal={deviceRefusal}
                newVersion={newVersion}
                saved={saved === null ? undefined : `${saved[0]}–${saved[1]}`}
                unsaved={isDirty}
                onReload={() => {
                  reloading.current = true
                }}
              />
            </div>
          )}

          {deviceRefusal === null && clearRefused !== null && (
            <div className="scoring__refused">
              <DeviceAlert
                refusal={{ action: 'clear', reason: clearRefused.reason }}
                newVersion={newVersion}
                saved={
                  clearRefused.saved === null
                    ? undefined
                    : `${clearRefused.saved[0]}–${clearRefused.saved[1]}`
                }
                game={clearRefused.game === game ? undefined : clearRefused.game}
                unsaved={isDirty}
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
                  disabled={pending}
                  onClick={clear}
                >
                  Clear
                </Button>
              )}
              <Button
                variant="primary"
                size="lg"
                type="submit"
                disabled={pending || finished}
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
          updates={updates}
        />
      </div>

      {blocker.status === 'blocked' && !heldMove && (
        <ConfirmDialog
          title="Leave without saving?"
          stayLabel="Keep editing"
          goLabel="Discard & leave"
          onStay={() => {
            blocker.reset()
            setFocus(lastField.current)
          }}
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

// A score as text, to tell two apart: "11-6"; '' for none.
function scoreText(score: Score | null): string {
  return score === null ? '' : `${score[0]}-${score[1]}`
}
