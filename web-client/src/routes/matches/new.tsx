import { useEffect, useRef, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { ArrowRight, Search } from 'lucide-react'
import { z } from 'zod'

import { AppShell } from '@/components/app-shell'
import { ApiError } from '@/api/client'
import { useSession } from '@/api/session'
import {
  nextScoringDestination,
  useCreateMatch,
  usePlayerSearch,
  useRecentOpponents,
  type Player,
} from '@/api/matches'
import { OpponentPickerBoundary } from '@/components/matches/opponent-picker-boundary'
import { UserAvatar } from '@/components/ui/user-avatar'
import { pageTitle } from '@/lib/page-title'
import { useDebouncedValue } from '@/lib/use-debounced-value'
import { cn } from '@/lib/utils'
import './new.css'

export const Route = createFileRoute('/matches/new')({
  head: () => ({
    meta: [{ title: pageTitle('New match') }],
  }),
  component: NewMatchPage,
})

/* ------------------------------------------------------------------ */
/*  Opponent model                                                    */
/* ------------------------------------------------------------------ */

interface Opponent {
  id: string
  name: string
}

function opponentFromPlayer(player: Player): Opponent {
  return { id: player.id, name: player.username }
}

/* ------------------------------------------------------------------ */
/*  Validation                                                        */
/* ------------------------------------------------------------------ */

// Rated matches need an opponent; the API enforces this independently. The
// client toggle is disabled when no opponent is picked, so this only fires
// in a near-impossible race — keep the refinement for defense in depth.
const matchFormSchema = z
  .object({
    hasOpponent: z.boolean(),
    rated: z.boolean(),
    bestOf: z.number(),
  })
  .refine((value) => !(value.rated && !value.hasOpponent), {
    message:
      'A rated match needs an opponent — pick one, or switch off Rated.',
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
  // Default off so submitting without picking an opponent "just works" —
  // the no-opponent match is unrated by definition.
  const [rated, setRated] = useState(false)
  const [apiError, setApiError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)

  const me = session?.data.user ?? null

  const validation = matchFormSchema.safeParse({
    hasOpponent: opponent !== null,
    rated,
    bestOf,
  })
  const validationError = validation.success
    ? null
    : (validation.error.issues[0]?.message ?? 'Check the match setup.')
  const error = apiError ?? (submitted ? validationError : null)

  async function handleSubmit() {
    setSubmitted(true)
    if (validationError) return
    setApiError(null)

    try {
      const created = await createMatch.mutateAsync({
        opponent_user_id: opponent?.id ?? null,
        best_of: bestOf,
        rated: opponent !== null && rated,
      })
      navigate(nextScoringDestination(created))
    } catch (err) {
      setApiError(
        err instanceof ApiError
          ? (err.detail ?? err.message)
          : 'Could not start the match. Try again.',
      )
    }
  }

  return (
    <div className="nm-card">
      <div className="nm-you-strip">
        <UserAvatar name={me?.username ?? '…'} size={36} dim={!me} />
        <div className="block">
          <span className="lbl">You</span>
          <span className="name">{me?.username ?? 'Loading…'}</span>
        </div>
      </div>

      <div className="nm-opp-block">
        <div className="nm-section-head">
          <span className="title">Opponent</span>
          <span className="hint">
            {opponent ? 'Rated-eligible' : 'Optional · leave blank for a solo match'}
          </span>
        </div>

        {opponent ? (
          <SelectedOpponent
            opponent={opponent}
            // Clearing the opponent must also clear `rated` — otherwise the
            // toggle's "off" appearance (because `effectiveRated` is gated by
            // `ratable`) hides a stored `true` that would either (a) trip the
            // rated-needs-opponent refinement with a disabled toggle the user
            // can't switch off, or (b) silently re-engage rating when a new
            // opponent is picked.
            onChange={() => {
              setOpponent(null)
              setRated(false)
            }}
          />
        ) : (
          <OpponentPickerBoundary>
            <RecentPicker
              onPick={(player) => setOpponent(opponentFromPlayer(player))}
            />
          </OpponentPickerBoundary>
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
  return (
    <div className="nm-selected">
      <UserAvatar name={opponent.name} size={48} />
      <div className="info">
        <div className="name">{opponent.name}</div>
        <div className="rating">REGISTERED PLAYER</div>
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
  // Wait for the session before fetching players — otherwise a first-visit
  // direct-load races the session cookie and 401s into the error boundary
  // (#98). A disabled query stays `isPending`, so the skeleton holds until the
  // session resolves rather than flashing the empty state.
  const session = useSession()
  const recent = useRecentOpponents({ enabled: session.isSuccess })
  const players = recent.data ?? []
  const isLoading = recent.isPending

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
          No other players yet. Start the match without picking one for a
          casual solo session.
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
              <UserAvatar name={p.username} size={32} />
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
        <UserAvatar name={p.username} size={36} />
        <div className="body">
          <div className="n">{p.username}</div>
          <div className="m">
            {p.rating != null
              ? `RATING ${Math.round(p.rating)}`
              : 'REGISTERED PLAYER'}
          </div>
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
  const ratable = opponent !== null
  const effectiveRated = rated && ratable

  let description: string
  if (effectiveRated) {
    description = 'Result will update both ratings.'
  } else if (ratable) {
    description = 'No rating change. Still logged to history.'
  } else {
    description = 'Pick an opponent to make this rated.'
  }

  return (
    <div>
      <div className="nm-field-label">
        Rated match
        {!ratable && <span className="na">No opponent · unavailable</span>}
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
  const effectivelyRated = rated && opponent !== null
  const gamesToWin = Math.ceil(bestOf / 2)
  const lengthCopy =
    bestOf === 1 ? 'Single game' : `Best of ${bestOf} · first to ${gamesToWin}`

  return (
    <div className="nm-summary">
      <div className="read">
        <div className="top">
          {opponent ? (
            <>
              Ready: <b>You</b> vs <b>{opponent.name}</b>
            </>
          ) : (
            <>
              Ready: <b>You</b> <span className="opp-tbd">· solo match</span>
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
