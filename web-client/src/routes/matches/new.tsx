import { useEffect, useRef, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { ArrowRight, Search } from 'lucide-react'
import { z } from 'zod'

import { AppShell } from '@/components/app-shell'
import { ApiError } from '@/api/client'
import { useSession } from '@/api/session'
import {
  useCreateMatch,
  usePlayerSearch,
  useRecentOpponents,
  type Player,
} from '@/api/matches'
import { OpponentPickerBoundary } from '@/components/matches/opponent-picker-boundary'
import { useDebouncedValue } from '@/lib/use-debounced-value'
import { cn } from '@/lib/utils'
import './new.css'

export const Route = createFileRoute('/matches/new')({
  component: NewMatchPage,
})

/* ------------------------------------------------------------------ */
/*  Opponent model                                                    */
/* ------------------------------------------------------------------ */

type OpponentKind = 'registered' | 'guest' | 'tbd'

interface Opponent {
  /** A real user id for `registered`; a sentinel string for guest / tbd. */
  id: string
  kind: OpponentKind
  name: string
}

const GUEST: Opponent = { id: 'guest', kind: 'guest', name: 'Guest player' }
const OPPONENT_TBD: Opponent = { id: 'tbd', kind: 'tbd', name: 'Opponent TBD' }

function registeredOpponent(player: Player): Opponent {
  return { id: player.id, kind: 'registered', name: player.username }
}

/** Two-letter monogram for an avatar bubble. */
function initialsOf(name: string): string {
  const parts = name.split(/[^a-zA-Z0-9]+/).filter(Boolean)
  const letters =
    parts.length >= 2
      ? parts[0][0] + parts[1][0]
      : name.replace(/[^a-zA-Z0-9]/g, '').slice(0, 2)
  return letters.toUpperCase() || '?'
}

/** Whether a match against this opponent can count toward ratings. */
function canRate(opponent: Opponent | null) {
  return !opponent || opponent.kind === 'registered'
}

/* ------------------------------------------------------------------ */
/*  Validation                                                        */
/* ------------------------------------------------------------------ */

// The backend independently enforces these rules; the client copy gives
// immediate, inline feedback before a round-trip. The two refinements are
// ordered so the rated-specific message wins when both would apply.
const matchFormSchema = z
  .object({
    opponentKind: z.enum(['registered', 'guest', 'tbd']).nullable(),
    rated: z.boolean(),
    bestOf: z.number(),
  })
  .refine((value) => !(value.rated && value.opponentKind === null), {
    message:
      'A rated match needs an opponent — pick one, or switch off Rated to play without one.',
    path: ['opponent'],
  })
  .refine((value) => value.opponentKind !== null, {
    message: "Choose an opponent, or pick 'Start without opponent'.",
    path: ['opponent'],
  })

/* ------------------------------------------------------------------ */
/*  Page                                                              */
/* ------------------------------------------------------------------ */

function NewMatchPage() {
  return (
    <AppShell>
      <div className="nm-page">
        <div className="nm-page-head">
          <h1>
            New match<span className="dot">.</span>
          </h1>
        </div>
        <MatchCard />
      </div>
    </AppShell>
  )
}

/* ------------------------------------------------------------------ */
/*  Match setup card                                                  */
/* ------------------------------------------------------------------ */

function MatchCard() {
  const navigate = useNavigate()
  const { data: session } = useSession()
  const createMatch = useCreateMatch()

  const [opponent, setOpponent] = useState<Opponent | null>(null)
  const [bestOf, setBestOf] = useState(5)
  const [rated, setRated] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const me = session?.data.user ?? null

  async function handleSubmit() {
    const parsed = matchFormSchema.safeParse({
      opponentKind: opponent?.kind ?? null,
      rated,
      bestOf,
    })
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the match setup.')
      return
    }
    setError(null)

    // Guest / "start without opponent" matches have a single side, so they
    // can never be rated regardless of the toggle.
    const isRegistered = opponent?.kind === 'registered'
    try {
      await createMatch.mutateAsync({
        opponent_user_id: isRegistered ? opponent.id : null,
        best_of: bestOf,
        rated: isRegistered && rated,
      })
      navigate({ to: '/dashboard' })
    } catch (err) {
      setError(
        err instanceof ApiError
          ? (err.detail ?? err.message)
          : 'Could not start the match. Try again.',
      )
    }
  }

  return (
    <div className="nm-card">
      <div className="nm-you-strip">
        <div className="av">{me ? initialsOf(me.username) : '··'}</div>
        <div className="block">
          <span className="lbl">You</span>
          <span className="name">{me?.username ?? 'Loading…'}</span>
        </div>
      </div>

      <div className="nm-opp-block">
        <div className="nm-section-head">
          <span className="title">Opponent</span>
          {opponent && (
            <span className="hint">
              {opponent.kind === 'registered'
                ? 'Rated player'
                : 'Guest · unrated'}
            </span>
          )}
        </div>

        {opponent ? (
          <SelectedOpponent
            opponent={opponent}
            onChange={() => setOpponent(null)}
          />
        ) : (
          <OpponentPickerBoundary>
            <RecentPicker
              onPick={(player) => setOpponent(registeredOpponent(player))}
            />
          </OpponentPickerBoundary>
        )}

        {!opponent && (
          <div className="nm-skip-row">
            <button type="button" onClick={() => setOpponent(GUEST)}>
              Add guest opponent
            </button>
            <span className="sep">·</span>
            <button type="button" onClick={() => setOpponent(OPPONENT_TBD)}>
              Start without opponent
            </button>
          </div>
        )}
      </div>

      <div className="nm-settings">
        <BestOfField bestOf={bestOf} setBestOf={setBestOf} />
        <RatedField rated={rated} setRated={setRated} opponent={opponent} />
      </div>

      <SubmitRow
        opponent={opponent}
        bestOf={bestOf}
        rated={rated}
        error={error}
        submitting={createMatch.isPending}
        onSubmit={handleSubmit}
        onCancel={() => navigate({ to: '/dashboard' })}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Opponent — selected pill                                          */
/* ------------------------------------------------------------------ */

function SelectedOpponent({
  opponent,
  onChange,
}: {
  opponent: Opponent
  onChange: () => void
}) {
  const guest = opponent.kind !== 'registered'
  const tag =
    opponent.kind === 'registered'
      ? 'REGISTERED PLAYER'
      : opponent.kind === 'guest'
        ? 'UNRATED GUEST'
        : 'TO BE DECIDED'
  return (
    <div className={cn('nm-selected', guest && 'guest')}>
      <div className="av">{initialsOf(opponent.name)}</div>
      <div className="info">
        <div className="name">{opponent.name}</div>
        <div className="rating">{tag}</div>
      </div>
      <button type="button" className="change" onClick={onChange}>
        Change
      </button>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Opponent — player grid (default)                                  */
/* ------------------------------------------------------------------ */

function RecentSkeleton() {
  return (
    <div className="nm-recent-grid" role="status" aria-label="Loading players">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="nm-chip-skel" aria-hidden="true">
          <div className="av" />
          <div className="lines">
            <div className="line" />
            <div className="line short" />
          </div>
        </div>
      ))}
    </div>
  )
}

function RecentPicker({ onPick }: { onPick: (player: Player) => void }) {
  const [showSearch, setShowSearch] = useState(false)
  const { data: players = [], isLoading } = useRecentOpponents()

  if (showSearch) return <TypeaheadPicker onPick={onPick} />

  return (
    <div>
      <div className="nm-recent-label">
        <span>Recent opponents</span>
        {!isLoading && players.length > 0 && (
          <button
            type="button"
            className="search-btn"
            onClick={() => setShowSearch(true)}
          >
            Search all players
          </button>
        )}
      </div>
      {isLoading ? (
        <RecentSkeleton />
      ) : players.length === 0 ? (
        <div className="nm-no-match">
          No other players yet. Add a guest, or start without an opponent.
        </div>
      ) : (
        <div className="nm-recent-grid">
          {players.map((p) => (
            <button
              type="button"
              key={p.id}
              className="nm-chip"
              onClick={() => onPick(p)}
            >
              <div className="av">{initialsOf(p.username)}</div>
              <div className="body">
                <div className="n">{p.username}</div>
                <div className="m">REGISTERED PLAYER</div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Opponent — typeahead search                                       */
/* ------------------------------------------------------------------ */

function TypeaheadPicker({ onPick }: { onPick: (player: Player) => void }) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(true)
  const [activeIdx, setActiveIdx] = useState(0)
  const wrapRef = useRef<HTMLDivElement>(null)

  // Trimmed and debounced; the (already-trimmed) term is the React Query key,
  // so each search lands in its own cache slot.
  const term = useDebouncedValue(query, 250).trim()
  const { data: results = [], isFetching } = usePlayerSearch(term)

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [])

  function changeQuery(value: string) {
    setQuery(value)
    setActiveIdx(0)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx((i) => Math.min(results.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const picked = results[activeIdx]
      if (picked) onPick(picked)
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  // `placeholderData` on the search query keeps the prior term's rows visible
  // while the next term loads, so this only fires on the very first search.
  const loadingFirstResults = isFetching && results.length === 0

  function renderBody() {
    if (!term) {
      return (
        <div className="nm-no-match">
          Start typing to search players by username.
        </div>
      )
    }
    if (loadingFirstResults) {
      return (
        <div className="nm-no-match" role="status">
          Searching…
        </div>
      )
    }
    if (results.length === 0) {
      return (
        <div className="nm-no-match">
          No one matches “{term}”. Try a different name.
        </div>
      )
    }
    return results.map((p, i) => (
      <button
        type="button"
        key={p.id}
        className={cn('nm-item', i === activeIdx && 'active')}
        onMouseEnter={() => setActiveIdx(i)}
        onClick={() => onPick(p)}
      >
        <div className="av">{initialsOf(p.username)}</div>
        <div className="body">
          <div className="n">{p.username}</div>
          <div className="m">REGISTERED PLAYER</div>
        </div>
      </button>
    ))
  }

  return (
    <div className="nm-search" ref={wrapRef}>
      <div className="nm-input-wrap">
        <Search className="search-icon" size={20} strokeWidth={1.75} />
        <input
          className="nm-input"
          placeholder="Search by username"
          value={query}
          autoFocus
          onChange={(e) => {
            changeQuery(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        {query && (
          <button
            type="button"
            className="nm-clear"
            aria-label="Clear search"
            onClick={() => changeQuery('')}
          >
            ×
          </button>
        )}
      </div>
      {open && <div className="nm-dropdown">{renderBody()}</div>}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Match length — best-of segmented control                          */
/* ------------------------------------------------------------------ */

const BEST_OF_OPTIONS = [
  { n: 1, label: 'Single' },
  { n: 3, label: 'Short' },
  { n: 5, label: 'Std' },
  { n: 7, label: 'Long' },
]

function BestOfField({
  bestOf,
  setBestOf,
}: {
  bestOf: number
  setBestOf: (n: number) => void
}) {
  return (
    <div>
      <div className="nm-field-label">Match length</div>
      <div className="nm-bestof" role="radiogroup" aria-label="Match length">
        {BEST_OF_OPTIONS.map((o) => (
          <button
            type="button"
            key={o.n}
            className={cn('nm-bestof-opt', bestOf === o.n && 'active')}
            role="radio"
            aria-checked={bestOf === o.n}
            onClick={() => setBestOf(o.n)}
          >
            <span className="big">{o.n}</span>
            <span className="sub">{o.label}</span>
          </button>
        ))}
      </div>
      <div className="nm-help">
        {bestOf === 1
          ? 'One game, winner takes all.'
          : `First to ${Math.ceil(bestOf / 2)} games.`}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Rated toggle                                                      */
/* ------------------------------------------------------------------ */

function RatedField({
  rated,
  setRated,
  opponent,
}: {
  rated: boolean
  setRated: (rated: boolean) => void
  opponent: Opponent | null
}) {
  const ratable = canRate(opponent)
  const effectiveRated = rated && ratable

  let description: string
  if (effectiveRated) {
    description = opponent
      ? 'Result will update both ratings.'
      : 'Pick a registered opponent for this to count.'
  } else if (ratable) {
    description = opponent
      ? 'No rating change. Still logged to history.'
      : 'No rating change either way. Still logged to history.'
  } else {
    description = 'Guest matches are always unrated.'
  }

  return (
    <div>
      <div className="nm-field-label">
        Rated match
        {!ratable && <span className="na">Guest · unavailable</span>}
      </div>
      <div className="nm-rated">
        <button
          type="button"
          className={cn('nm-switch', effectiveRated && 'on')}
          role="switch"
          aria-checked={effectiveRated}
          aria-label="Rated match"
          disabled={!ratable}
          onClick={() => ratable && setRated(!rated)}
        />
        <div className="nm-rated-info">
          <div className="t">
            {effectiveRated ? 'Counts toward rating' : 'Just for fun'}
          </div>
          <div className="d">{description}</div>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Submit row                                                        */
/* ------------------------------------------------------------------ */

function SubmitRow({
  opponent,
  bestOf,
  rated,
  error,
  submitting,
  onSubmit,
  onCancel,
}: {
  opponent: Opponent | null
  bestOf: number
  rated: boolean
  error: string | null
  submitting: boolean
  onSubmit: () => void
  onCancel: () => void
}) {
  const effectivelyRated = rated && opponent?.kind === 'registered'
  const gamesToWin = Math.ceil(bestOf / 2)
  const lengthCopy =
    bestOf === 1 ? 'Single game' : `Best of ${bestOf} · first to ${gamesToWin}`

  return (
    <div className="nm-summary">
      <div className="read">
        <div className="top">
          {opponent?.kind === 'registered' ? (
            <>
              Ready: <b>You</b> vs <b>{opponent.name}</b>
            </>
          ) : opponent ? (
            <>
              You vs <span className="opp-tbd">{opponent.name}</span>
            </>
          ) : (
            <>
              You vs <span className="opp-tbd">pick an opponent</span>
            </>
          )}
        </div>
        <div className="sub">
          {lengthCopy}
          <span className="dot">·</span>
          {effectivelyRated ? (
            <span className="rated">Rated</span>
          ) : (
            <span className="unrated">Unrated</span>
          )}
          <span className="dot">·</span>
          games to 11, win by 2
        </div>
        {error && (
          <p className="nm-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="actions">
        <button
          type="button"
          className="nm-btn nm-btn-ghost"
          onClick={onCancel}
          disabled={submitting}
        >
          Cancel
        </button>
        <button
          type="button"
          className="nm-btn nm-btn-primary"
          onClick={onSubmit}
          disabled={submitting}
        >
          {submitting ? 'Starting…' : 'Start match'}
          {!submitting && <ArrowRight size={16} strokeWidth={2.5} />}
        </button>
      </div>
    </div>
  )
}
