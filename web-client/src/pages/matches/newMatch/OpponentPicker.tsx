import { useSuspenseQuery } from '@tanstack/react-query'
import { useRouteContext } from '@tanstack/react-router'
import { useDeferredValue, useEffect, useRef, useState, type RefObject } from 'react'
import { opponentsQuery, type Opponent as ListedPlayer } from '../../../api/queries'
import { Button } from '../../../components/Button'
import { EmptyState } from '../../../components/EmptyState'
import { Icon } from '../../../components/Icon'
import { PlayerAvatar } from '../../../components/PlayerAvatar'
import { QueryBoundary } from '../../../components/QueryBoundary'
import type { Opponent, OpponentChoice } from './setup'

// How long the search waits after a key before it asks the API.
export const SEARCH_DELAY_MS = 200

type Focus = 'change' | 'searchAll' | null

// Who the match is against: the picked player with Change, or the picker.
// The picker shows the account's recent opponents, and Search all players
// switches it to a search of every player. Focus follows the control that
// replaced the one pressed, so it never drops to the page.
export function OpponentPicker({
  choice,
  onPick,
  onClear,
}: {
  choice: OpponentChoice
  onPick: (opponent: Opponent) => void
  onClear: () => void
}) {
  const [searching, setSearching] = useState(false)
  const focusRef = useRef<Focus>(null)

  if (choice.kind === 'picked') {
    return (
      <Picked
        opponent={choice.opponent}
        focusRef={focusRef}
        onChange={() => {
          focusRef.current = 'searchAll'
          setSearching(false)
          onClear()
        }}
      />
    )
  }
  const pick = (player: ListedPlayer) => {
    focusRef.current = 'change'
    onPick({ id: player.id, name: player.display_name })
  }
  if (searching) {
    return (
      <Search
        onPick={pick}
        onBack={() => {
          focusRef.current = 'searchAll'
          setSearching(false)
        }}
      />
    )
  }
  return <Recent focusRef={focusRef} onPick={pick} onSearch={() => setSearching(true)} />
}

function useFocusOnMount<T extends HTMLElement>(focusRef: RefObject<Focus>, when: Focus) {
  const element = useRef<T>(null)
  useEffect(() => {
    if (focusRef.current !== when) return
    focusRef.current = null
    element.current?.focus()
  }, [focusRef, when])
  return element
}

function Picked({
  opponent,
  focusRef,
  onChange,
}: {
  opponent: Opponent
  focusRef: RefObject<Focus>
  onChange: () => void
}) {
  const change = useFocusOnMount<HTMLButtonElement>(focusRef, 'change')
  return (
    <div className="new-match__picked">
      <PlayerAvatar name={opponent.name} />
      <span className="new-match__name">{opponent.name}</span>
      <Button ref={change} variant="secondary" size="sm" onClick={onChange}>
        Change
      </Button>
    </div>
  )
}

function Recent({
  focusRef,
  onPick,
  onSearch,
}: {
  focusRef: RefObject<Focus>
  onPick: (player: ListedPlayer) => void
  onSearch: () => void
}) {
  const searchAll = useFocusOnMount<HTMLButtonElement>(focusRef, 'searchAll')
  return (
    <div className="new-match__picker">
      <div className="new-match__picker-head">
        <span className="new-match__sub">Recent opponents</span>
        <Button ref={searchAll} variant="link" size="sm" onClick={onSearch}>
          <Icon name="search" />
          Search all players
        </Button>
      </div>
      <QueryBoundary skeleton={<PlayersSkeleton label="Loading recent opponents" />}>
        <RecentOpponents onPick={onPick} />
      </QueryBoundary>
    </div>
  )
}

function RecentOpponents({ onPick }: { onPick: (player: ListedPlayer) => void }) {
  const { api } = useRouteContext({ from: '__root__' })
  const { data: players } = useSuspenseQuery(opponentsQuery(api, ''))
  if (players.length === 0) {
    return (
      <EmptyState title="No opponents yet">
        Search all players to find who you’re playing. The players you play show up here.
      </EmptyState>
    )
  }
  return <Players label="Recent opponents" players={players} onPick={onPick} />
}

function Search({ onPick, onBack }: { onPick: (player: ListedPlayer) => void; onBack: () => void }) {
  const [text, setText] = useState('')
  const [term, setTerm] = useState('')
  useEffect(() => {
    const timer = setTimeout(() => setTerm(text.trim()), SEARCH_DELAY_MS)
    return () => clearTimeout(timer)
  }, [text])
  // While the next search loads, the last one's players stay up.
  const shown = useDeferredValue(term)
  return (
    <div className="new-match__picker">
      <div className="new-match__picker-head">
        <Button variant="link" size="sm" onClick={onBack}>
          <Icon name="back" />
          Back to recent opponents
        </Button>
      </div>
      <div className="fm-combo new-match__search">
        <Icon name="search" />
        <input
          className="fm-input"
          type="search"
          aria-label="Search players by name"
          placeholder="Search by name"
          autoComplete="off"
          // The search opens only from Search all players, so it takes focus.
          autoFocus
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </div>
      {shown ? (
        <QueryBoundary skeleton={<PlayersSkeleton label="Searching players" />}>
          <SearchResults term={shown} onPick={onPick} />
        </QueryBoundary>
      ) : (
        <p className="fm-help">Type part of a player’s name.</p>
      )}
    </div>
  )
}

function SearchResults({ term, onPick }: { term: string; onPick: (player: ListedPlayer) => void }) {
  const { api } = useRouteContext({ from: '__root__' })
  const { data: players } = useSuspenseQuery(opponentsQuery(api, term))
  if (players.length === 0) {
    return <p className="fm-help" role="status">No players match “{term}”. Check the spelling.</p>
  }
  return <Players label="Players found" players={players} onPick={onPick} />
}

function Players({
  label,
  players,
  onPick,
}: {
  label: string
  players: readonly ListedPlayer[]
  onPick: (player: ListedPlayer) => void
}) {
  return (
    <ul className="new-match__players" aria-label={label}>
      {players.map((player) => (
        <li key={player.id}>
          <button type="button" className="new-match__player" onClick={() => onPick(player)}>
            <span aria-hidden="true">
              <PlayerAvatar name={player.display_name} />
            </span>
            <span className="new-match__name">{player.display_name}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}

function PlayersSkeleton({ label }: { label: string }) {
  return (
    <div className="new-match__players" role="status" aria-label={label}>
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="fm-skeleton new-match__player-skeleton" aria-hidden="true" />
      ))}
    </div>
  )
}
