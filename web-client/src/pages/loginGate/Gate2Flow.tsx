import { useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState, type Ref } from 'react'
import { Button } from '../../components/Button'
import { Icon } from '../../components/Icon'
import { DashboardToast } from './GateParts'
import {
  fetchMatches,
  LATENCY,
  matchCount,
  outcome,
  serverPages,
  SHOWN,
  type Gate2Account,
  type Gate2Match,
  type ManagedPlayer,
  type Scenario,
  type SourcePlayer,
} from './gate2Data'

type Action =
  | { kind: 'yes' }
  | { kind: 'separate' }
  | { kind: 'merge'; into: ManagedPlayer }
  | { kind: 'remove' }

type View = 'question' | 'manage' | 'pick' | 'history'

type History = {
  rows: readonly Gate2Match[]
  // The page to fetch next, or null at the end of the history.
  next: number | null
  loading: boolean
  failed: boolean
  scrollTop: number
}

type Done = { player: string; message: string }

// Where a frame starts. Every frame works from there.
export type FlowStart = {
  index?: number
  view?: View
  // A managed player's id, or 'separate'.
  picked?: string
  saving?: Action
  failed?: Action
  notice?: string
  done?: Done
  // History pages the current player already loaded.
  history?: { pages: number; loading?: boolean; failed?: boolean }
}

const SEPARATE = 'separate'

// The player the account gets when nothing gives it one. The API makes it
// with a default name.
const NEW_MAIN = 'quiet quail 718'

const emptyHistory: History = { rows: [], next: 0, loading: false, failed: false, scrollTop: 0 }

// Rows that aren't in `rows` yet, by id, so a page never shows twice.
function append(rows: readonly Gate2Match[], more: readonly Gate2Match[]): Gate2Match[] {
  const ids = new Set(rows.map((row) => row.id))
  return [...rows, ...more.filter((row) => !ids.has(row.id))]
}

function shortDate(match: Gate2Match): string {
  return match.date.split(', ')[1] ?? match.date
}

// The gate on /login-gate2, on simulated data. It asks about one player at a
// time and saves each answer after LATENCY. `hold` keeps saves and history
// pages pending, for a frame that shows them.
export function Gate2Flow({
  scenario,
  start = {},
  hold = false,
}: {
  scenario: Scenario
  start?: FlowStart
  hold?: boolean
}) {
  const { queue } = scenario
  const [account, setAccount] = useState<Gate2Account>(scenario.account)
  const [index, setIndex] = useState(start.index ?? 0)
  const [view, setView] = useState<View>(start.view ?? 'question')
  const [picked, setPicked] = useState<string | null>(start.picked ?? null)
  const [saving, setSaving] = useState<Action | null>(start.saving ?? null)
  const [failed, setFailed] = useState<Action | null>(start.failed ?? null)
  const [notice, setNotice] = useState<string | null>(start.notice ?? null)
  const [done, setDone] = useState<Done | null>(start.done ?? null)
  const [histories, setHistories] = useState<Record<string, History>>(() => {
    const player = queue[start.index ?? 0]
    if (!start.history) return {}
    const { rows, next } = serverPages(player.id, start.history.pages)
    return {
      [player.id]: {
        rows,
        next,
        loading: start.history.loading ?? false,
        failed: start.history.failed ?? false,
        scrollTop: 0,
      },
    }
  })
  const saveAttempts = useRef(0)
  const pageAttempts = useRef(new Map<string, number>())
  const inFlight = useRef(new Set<string>())
  const scroller = useRef<HTMLDivElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const viewAll = useRef<HTMLButtonElement>(null)
  const sentinel = useRef<HTMLDivElement>(null)
  // Where focus goes after the next render, once someone acts. A frame's
  // first render moves no focus.
  const focusNext = useRef<'heading' | 'viewAll' | null>(null)
  const titleId = useId()

  const player = queue[index]
  const history = histories[player.id] ?? emptyHistory
  const eligible = account.managed.filter((managed) => managed.id !== player.id)
  const busy = saving !== null

  useEffect(() => {
    const target = focusNext.current === 'viewAll' ? viewAll.current : heading.current
    if (focusNext.current) target?.focus()
    focusNext.current = null
  }, [index, view])

  // Back in the history view, it opens where it was left.
  const restoreScroll = useEffectEvent(() => {
    if (scroller.current) scroller.current.scrollTop = view === 'history' ? history.scrollTop : 0
  })
  useLayoutEffect(() => {
    restoreScroll()
  }, [view, index])

  function go(next: View, focus: 'heading' | 'viewAll' = 'heading') {
    focusNext.current = focus
    setView(next)
  }

  function updateHistory(playerId: string, change: (history: History) => History) {
    setHistories((all) => ({ ...all, [playerId]: change(all[playerId] ?? emptyHistory) }))
  }

  function loadPage(playerId: string, page: number) {
    const key = `${playerId}:${page}`
    if (inFlight.current.has(key)) return
    inFlight.current.add(key)
    updateHistory(playerId, (current) => ({ ...current, loading: true, failed: false }))
    if (hold) return
    const tries = pageAttempts.current.get(key) ?? 0
    pageAttempts.current.set(key, tries + 1)
    fetchMatches(playerId, page, scenario.failPage === page && tries === 0)
      .then(({ rows, next }) =>
        updateHistory(playerId, (current) => ({ ...current, rows: append(current.rows, rows), next, loading: false })),
      )
      .catch(() => updateHistory(playerId, (current) => ({ ...current, loading: false, failed: true })))
      .finally(() => inFlight.current.delete(key))
  }

  // The next page loads as the end of the list comes near. The observer
  // starts again after each page, so a short list keeps loading until it
  // fills the screen.
  const { next, loading, failed: pageFailed } = history
  const loaded = history.rows.length
  const loadNext = useEffectEvent((page: number) => loadPage(player.id, page))
  useEffect(() => {
    const node = sentinel.current
    if (view !== 'history' || next === null || loading || pageFailed || loaded === 0) return
    if (!node || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadNext(next)
      },
      { root: scroller.current, rootMargin: '0px 0px 240px 0px' },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [view, next, loading, pageFailed, loaded])

  function openHistory() {
    if (history.rows.length === 0 && !history.loading) loadPage(player.id, 0)
    go('history')
  }

  function closeHistory() {
    const top = scroller.current?.scrollTop ?? 0
    updateHistory(player.id, (current) => ({ ...current, scrollTop: top }))
    go('question', 'viewAll')
  }

  function finish(action: Action) {
    let after = account
    let message: string
    switch (action.kind) {
      case 'yes':
        if (account.main) {
          message = `${matchCount(player.total)} added to ${account.main}.`
        } else {
          after = { ...account, main: player.name }
          message = `${player.name} is your player now.`
        }
        break
      case 'separate':
        after = {
          ...account,
          managed: [
            ...account.managed,
            {
              id: player.id,
              name: player.name,
              summary: `${matchCount(player.total)} · latest ${shortDate(player.recent[0])}`,
            },
          ],
        }
        message = `You manage ${player.name} now.`
        break
      case 'merge':
        message = `${matchCount(player.total)} added to ${action.into.name}.`
        break
      case 'remove':
        message = `${player.name} removed from your account.`
        break
    }
    setAccount(after)
    setSaving(null)
    setFailed(null)
    setPicked(null)
    if (index + 1 < queue.length) {
      focusNext.current = 'heading'
      setIndex(index + 1)
      setView('question')
      setNotice(message)
    } else {
      setDone({ player: after.main ?? NEW_MAIN, message })
    }
  }

  function save(action: Action) {
    if (busy) return
    setSaving(action)
    setFailed(null)
    if (hold) return
    setTimeout(() => {
      const fails = scenario.failFirstSave && saveAttempts.current === 0
      saveAttempts.current += 1
      if (fails) {
        setSaving(null)
        setFailed(action)
        return
      }
      finish(action)
    }, LATENCY)
  }

  function manage() {
    if (eligible.length === 0) save({ kind: 'separate' })
    else {
      setPicked(null)
      go('pick')
    }
  }

  if (done) return <DashboardToast player={done.player} message={done.message} undo={false} />

  const progress = queue.length > 1 && (
    <p className="g2-progress">
      Player {index + 1} of {queue.length}
    </p>
  )
  const savingKind = saving?.kind
  const pickedPlayer = eligible.find((managed) => managed.id === picked)

  function pickAction(): Action | null {
    if (picked === SEPARATE) return { kind: 'separate' }
    return pickedPlayer ? { kind: 'merge', into: pickedPlayer } : null
  }

  return (
    <div className="g2" ref={scroller} role="group" aria-labelledby={titleId}>
      <div className="g2-content">
        <div className="g2-wordmark">FortyMM</div>
        <div className="g2-body">
          {notice && index > 0 && view === 'question' && (
            <p className="fm-notice fm-notice--success" role="status">
              <Icon name="check" />
              <span>
                {notice}
                <span className="fm-sr">
                  {' '}
                  Player {index + 1} of {queue.length} next.
                </span>
              </span>
            </p>
          )}
          <div className="g2-head">
            {progress}
            <h3 id={titleId} className="g2-title" ref={heading} tabIndex={-1}>
              {view === 'question' && 'Did you play these matches?'}
              {view === 'manage' && 'Do you manage this player?'}
              {view === 'pick' && 'Which player?'}
              {view === 'history' && `All ${player.total} matches`}
            </h3>
            <p className="g2-source">
              Played as {player.name}
              {(view === 'history' || view === 'manage') && ` · ${matchCount(player.total)} · ${player.range}`}
            </p>
          </div>

          {view === 'question' && (
            <>
              <Matches player={player} onViewAll={openHistory} viewAllRef={viewAll} />
              <p className="g2-outcome">{outcome(player, account)}</p>
            </>
          )}

          {view === 'pick' && (
            <fieldset className="g2-pick" disabled={busy}>
              <legend className="fm-sr">Which player?</legend>
              {eligible.map((managed) => (
                <label key={managed.id} className="fm-radio g2-option">
                  <input
                    type="radio"
                    name={titleId}
                    checked={picked === managed.id}
                    onChange={() => setPicked(managed.id)}
                  />
                  <span className="g2-option__text">
                    <span className="g2-option__label">{managed.name}</span>
                    <span className="fm-help">{managed.summary}</span>
                  </span>
                </label>
              ))}
              <label className="fm-radio g2-option">
                <input
                  type="radio"
                  name={titleId}
                  checked={picked === SEPARATE}
                  onChange={() => setPicked(SEPARATE)}
                />
                <span className="g2-option__text">
                  <span className="g2-option__label">Keep as a separate player</span>
                  <span className="fm-help">For someone who isn’t in your account yet.</span>
                </span>
              </label>
            </fieldset>
          )}

          {view === 'history' && (
            <div className="g2-matches">
              <MatchList matches={history.rows} label="All matches" />
              <div ref={sentinel} />
              {history.loading && (
                <p className="g2-history-status" role="status">
                  <span className="g2-spinner" aria-hidden="true" />
                  Loading matches…
                </p>
              )}
              {history.failed && (
                <div className="g2-history-status" role="alert">
                  <span>These matches didn’t load.</span>
                  <Button variant="secondary" size="sm" onClick={() => loadPage(player.id, history.next ?? 0)}>
                    Retry
                  </Button>
                </div>
              )}
              {history.next === null && !history.loading && (
                <p className="g2-history-status">That’s all {matchCount(player.total)}.</p>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="g2-bar">
        <div className="g2-bar__inner">
          {failed && view !== 'history' && (
            <div className="fm-alert fm-alert--error" role="alert">
              <Icon name="error" />
              <p className="fm-alert__title">Your answer wasn’t saved. Please try again.</p>
            </div>
          )}

          {view === 'question' && (
            <>
              <Button variant="primary" size="lg" busy={savingKind === 'yes'} onClick={() => save({ kind: 'yes' })}>
                {savingKind === 'yes' ? 'Saving…' : 'Yes, these were mine'}
              </Button>
              <Button variant="secondary" size="lg" aria-disabled={busy || undefined} onClick={() => go('manage')}>
                Someone else played
              </Button>
            </>
          )}

          {view === 'manage' && (
            <>
              <Button
                variant="secondary"
                size="lg"
                busy={savingKind === 'separate'}
                aria-disabled={(busy && savingKind !== 'separate') || undefined}
                onClick={manage}
              >
                {savingKind === 'separate' ? 'Saving…' : 'I manage this player'}
              </Button>
              <Button
                variant="secondary"
                size="lg"
                busy={savingKind === 'remove'}
                aria-disabled={(busy && savingKind !== 'remove') || undefined}
                aria-describedby={`${titleId}-remove`}
                onClick={() => save({ kind: 'remove' })}
              >
                {savingKind === 'remove' ? 'Saving…' : 'Remove from my account'}
              </Button>
              <p id={`${titleId}-remove`} className="g2-note">
                The player and their matches stay in FortyMM.
              </p>
              <Button variant="ghost" className="g2-back" aria-disabled={busy || undefined} onClick={() => go('question')}>
                <Icon name="left" />
                Back
              </Button>
            </>
          )}

          {view === 'pick' && (
            <>
              <Button
                variant="primary"
                size="lg"
                busy={busy}
                aria-disabled={pickAction() === null || undefined}
                onClick={() => {
                  const action = pickAction()
                  if (action) save(action)
                }}
              >
                {busy
                  ? 'Saving…'
                  : picked === SEPARATE
                    ? 'Keep as a separate player'
                    : pickedPlayer
                      ? `Add to ${pickedPlayer.name}`
                      : 'Choose a player'}
              </Button>
              <Button variant="ghost" className="g2-back" aria-disabled={busy || undefined} onClick={() => go('manage')}>
                <Icon name="left" />
                Back
              </Button>
            </>
          )}

          {view === 'history' && (
            <Button variant="secondary" size="lg" onClick={closeHistory}>
              <Icon name="left" />
              Back to the question
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

function MatchList({ matches, label }: { matches: readonly Gate2Match[]; label: string }) {
  return (
    <ul className="g2-list" aria-label={label}>
      {matches.map((match) => (
        <li key={match.id}>
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

// The 3 newest matches, with the count and dates of the whole history. With
// more, it says how many it shows and offers the rest.
function Matches({
  player,
  onViewAll,
  viewAllRef,
}: {
  player: SourcePlayer
  onViewAll: () => void
  viewAllRef: Ref<HTMLButtonElement>
}) {
  const sample = player.total > SHOWN
  return (
    <div className="g2-matches">
      <p className="g2-matches__summary">
        {matchCount(player.total)} · {player.range}
      </p>
      {sample && (
        <p className="g2-matches__head">
          <span>Recent matches</span>
          <span>
            Showing {SHOWN} of {player.total}
          </span>
        </p>
      )}
      <MatchList matches={player.recent} label={sample ? 'Recent matches' : 'Matches'} />
      {sample && (
        <Button variant="link" className="g2-view-all" ref={viewAllRef} onClick={onViewAll}>
          View all {player.total} matches
        </Button>
      )}
    </div>
  )
}
