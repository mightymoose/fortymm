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
  saving?: Action
  failed?: Action
  notice?: string
  done?: Done
  // History pages the current player already loaded.
  history?: { pages: number; loading?: boolean; failed?: boolean }
}

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
// pages pending, for a frame that shows them. `fullScreen` fills the window
// and scrolls the page, as the real gate does. Otherwise the gate scrolls
// inside its frame.
export function Gate2Flow({
  scenario,
  start = {},
  hold = false,
  fullScreen = false,
}: {
  scenario: Scenario
  start?: FlowStart
  hold?: boolean
  fullScreen?: boolean
}) {
  const { queue } = scenario
  const [account, setAccount] = useState<Gate2Account>(scenario.account)
  const [index, setIndex] = useState(start.index ?? 0)
  const [view, setView] = useState<View>(start.view ?? 'question')
  // The step "View all" left, to go back to.
  const [historyFrom, setHistoryFrom] = useState<View>('question')
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

  // What scrolls: the page, or the gate in its frame.
  function scrollBox(): Element | null {
    return fullScreen ? document.scrollingElement : scroller.current
  }

  useEffect(() => {
    const target = focusNext.current === 'viewAll' ? viewAll.current : heading.current
    if (focusNext.current) target?.focus()
    focusNext.current = null
  }, [index, view])

  // Back in the history view, it opens where it was left.
  const restoreScroll = useEffectEvent(() => {
    const box = scrollBox()
    if (box) box.scrollTop = view === 'history' ? history.scrollTop : 0
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
      { root: fullScreen ? null : scroller.current, rootMargin: '0px 0px 240px 0px' },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [view, next, loading, pageFailed, loaded, fullScreen])

  function openHistory() {
    if (history.rows.length === 0 && !history.loading) loadPage(player.id, 0)
    setHistoryFrom(view)
    go('history')
  }

  function closeHistory() {
    const top = scrollBox()?.scrollTop ?? 0
    updateHistory(player.id, (current) => ({ ...current, scrollTop: top }))
    go(historyFrom, 'viewAll')
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
              total: player.total,
              lastMatch: `${player.recent[0].opponent} on ${shortDate(player.recent[0])}`,
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
    else go('pick')
  }

  if (done) {
    const toast = <DashboardToast player={done.player} message={done.message} undo={false} />
    return fullScreen ? <div className="g2-done--full">{toast}</div> : toast
  }

  const progress = queue.length > 1 && (
    <p className="g2-progress">
      Player {index + 1} of {queue.length}
    </p>
  )
  const savingKind = saving?.kind

  // Whether `action` is the answer that is saving now.
  function savingThis(action: Action): boolean {
    return saving !== null && sameAction(saving, action)
  }

  const saveError = failed && (
    <div className="fm-alert fm-alert--error" role="alert">
      <Icon name="error" />
      <p className="fm-alert__title">Your answer wasn’t saved. Please try again.</p>
    </div>
  )

  return (
    <div className={fullScreen ? 'g2 g2--full' : 'g2'} ref={scroller} role="group" aria-labelledby={titleId}>
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
              {view === 'manage' && 'Who played these matches?'}
              {view === 'pick' && 'Which of your players played these?'}
              {view === 'history' && `All ${player.total} matches`}
            </h3>
            <p className="g2-source">
              Played as {player.name}
              {view === 'history' && ` · ${matchCount(player.total)} · ${player.range}`}
            </p>
          </div>

          {view !== 'history' && <Matches player={player} onViewAll={openHistory} viewAllRef={viewAll} />}
          {view === 'question' && <p className="g2-outcome">{outcome(player, account)}</p>}

          {view === 'manage' && (
            <div className="g2-choices">
              {saveError}
              <Choice
                label="Someone I manage"
                help="Like your child, or a club member you look after. Their matches stay in your account, apart from yours."
                saving={savingThis({ kind: 'separate' })}
                off={busy}
                onClick={manage}
              />
              <Choice
                label="Not someone I know"
                help="These matches come off your account. They stay in FortyMM."
                saving={savingThis({ kind: 'remove' })}
                off={busy}
                onClick={() => save({ kind: 'remove' })}
              />
              <Back disabled={busy} onClick={() => go('question')} />
            </div>
          )}

          {view === 'pick' && (
            <div className="g2-choices">
              {saveError}
              {eligible.map((managed) => (
                <Choice
                  key={managed.id}
                  label={managed.name}
                  help={`${matchCount(managed.total)}. Last against ${managed.lastMatch}.`}
                  saving={savingThis({ kind: 'merge', into: managed })}
                  off={busy}
                  onClick={() => save({ kind: 'merge', into: managed })}
                />
              ))}
              <Choice
                label="Someone new"
                help="Keep these matches as a new player you manage."
                saving={savingThis({ kind: 'separate' })}
                off={busy}
                onClick={() => save({ kind: 'separate' })}
              />
              <Back disabled={busy} onClick={() => go('manage')} />
            </div>
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

      {(view === 'question' || view === 'history') && (
        <div className="g2-bar">
          <div className="g2-bar__inner">
            {view === 'question' && (
              <>
                {saveError}
                <Button variant="primary" size="lg" busy={savingKind === 'yes'} onClick={() => save({ kind: 'yes' })}>
                  {savingKind === 'yes' ? 'Saving…' : 'Yes, these were mine'}
                </Button>
                <Button variant="secondary" size="lg" aria-disabled={busy || undefined} onClick={() => go('manage')}>
                  Someone else played
                </Button>
              </>
            )}
            {view === 'history' && (
              <Button variant="secondary" size="lg" onClick={closeHistory}>
                <Icon name="left" />
                Back
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function sameAction(a: Action, b: Action): boolean {
  if (a.kind === 'merge' && b.kind === 'merge') return a.into.id === b.into.id
  return a.kind === b.kind
}

// One choice of step 2 or the picker: one tap saves it. While it saves, it
// shows Saving…, and while any answer saves, the other choices are off.
function Choice({
  label,
  help,
  saving,
  off,
  onClick,
}: {
  label: string
  help: string
  saving: boolean
  off: boolean
  onClick: () => void
}) {
  return (
    <Button
      variant="secondary"
      className="g2-choice"
      busy={saving}
      aria-disabled={(off && !saving) || undefined}
      onClick={onClick}
    >
      <span className="g2-choice__label">{saving ? 'Saving…' : label}</span>
      <span className="g2-choice__help">{help}</span>
    </Button>
  )
}

function Back({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return (
    <Button variant="ghost" className="g2-back" aria-disabled={disabled || undefined} onClick={onClick}>
      <Icon name="left" />
      Back
    </Button>
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
