import { useEffect, useMemo, useRef, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { ArrowRight, Search } from 'lucide-react'

import { AppShell } from '@/components/app-shell'
import './new.css'

export const Route = createFileRoute('/matches/new')({
  component: NewMatchPage,
})

/* ------------------------------------------------------------------ */
/*  Mock data — no backend wired up yet, this is UI only.             */
/* ------------------------------------------------------------------ */

interface Player {
  id: string
  name: string
  initials: string
  rating: number | null
  club: string
  lastPlayed: string
  recent: boolean
  isGuest?: boolean
}

const ME = { id: 'me', name: 'You', initials: 'YZ', rating: 1742 }

const PLAYERS: Player[] = [
  { id: 'p1', name: 'Nguyen, T.', initials: 'NT', rating: 2145, club: 'Hanoi TT', lastPlayed: '3 days ago', recent: true },
  { id: 'p2', name: 'Okafor, D.', initials: 'OD', rating: 1988, club: 'Lagos Club', lastPlayed: '1 week ago', recent: true },
  { id: 'p3', name: 'Silva, R.', initials: 'SR', rating: 1820, club: 'São Paulo', lastPlayed: 'Yesterday', recent: true },
  { id: 'p4', name: 'Patel, M.', initials: 'PM', rating: 1756, club: 'Hanoi TT', lastPlayed: '2 weeks ago', recent: true },
  { id: 'p5', name: 'Johansen, A.', initials: 'JA', rating: 1912, club: 'Oslo Bat', lastPlayed: '—', recent: false },
  { id: 'p6', name: 'Chen, W.', initials: 'CW', rating: 1680, club: 'Hanoi TT', lastPlayed: '—', recent: false },
  { id: 'p7', name: 'Park, J.', initials: 'PJ', rating: 2041, club: 'Seoul Open', lastPlayed: '—', recent: false },
  { id: 'p8', name: 'Tran, L.', initials: 'TL', rating: 1604, club: 'Hanoi TT', lastPlayed: '—', recent: false },
  { id: 'p9', name: 'Rossi, G.', initials: 'RG', rating: 1845, club: 'Roma TT', lastPlayed: '—', recent: false },
  { id: 'p10', name: 'Dubois, C.', initials: 'DC', rating: 1720, club: 'Paris Smash', lastPlayed: '—', recent: false },
]

const GUEST: Player = {
  id: 'guest',
  name: 'Guest player',
  initials: '?',
  rating: null,
  club: '',
  lastPlayed: '',
  recent: false,
  isGuest: true,
}

const OPPONENT_TBD: Player = {
  id: 'tbd',
  name: 'Opponent TBD',
  initials: '?',
  rating: null,
  club: '',
  lastPlayed: '',
  recent: false,
  isGuest: true,
}

/** Feel-good Elo-ish swing preview — not a real rating calculation. */
function estimateDelta(myRating: number, oppRating: number) {
  const mod = Math.max(-8, Math.min(8, Math.round((oppRating - myRating) / 60)))
  return 16 + mod
}

/* ------------------------------------------------------------------ */
/*  Page                                                              */
/* ------------------------------------------------------------------ */

function NewMatchPage() {
  const [opponent, setOpponent] = useState<Player | null>(null)
  const [bestOf, setBestOf] = useState(5)
  const [rated, setRated] = useState(true)

  return (
    <AppShell>
      <div className="nm-page">
        <div className="nm-page-head">
          <h1>
            New match<span className="dot">.</span>
          </h1>
        </div>
        <MatchCard
          opponent={opponent}
          setOpponent={setOpponent}
          bestOf={bestOf}
          setBestOf={setBestOf}
          rated={rated}
          setRated={setRated}
        />
      </div>
    </AppShell>
  )
}

/* ------------------------------------------------------------------ */
/*  Match setup card                                                  */
/* ------------------------------------------------------------------ */

interface MatchCardProps {
  opponent: Player | null
  setOpponent: (player: Player | null) => void
  bestOf: number
  setBestOf: (n: number) => void
  rated: boolean
  setRated: (rated: boolean) => void
}

function MatchCard({
  opponent,
  setOpponent,
  bestOf,
  setBestOf,
  rated,
  setRated,
}: MatchCardProps) {
  return (
    <div className="nm-card">
      {/* Compact "You" strip */}
      <div className="nm-you-strip">
        <div className="av">{ME.initials}</div>
        <div className="block">
          <span className="lbl">You</span>
          <span className="name">{ME.name}</span>
        </div>
        <div className="stats">
          <span>
            Rating <b>{ME.rating}</b>
          </span>
          <span className="streak">
            Streak <b>W4</b>
          </span>
        </div>
      </div>

      {/* Primary: opponent */}
      <div className="nm-opp-block">
        <div className="nm-section-head">
          <span className="title">Opponent</span>
          {opponent && (
            <span className="hint">
              {opponent.isGuest ? 'Guest · unrated' : 'Rated player'}
            </span>
          )}
        </div>

        {opponent ? (
          <SelectedOpponent
            opponent={opponent}
            onChange={() => setOpponent(null)}
          />
        ) : (
          <RecentPicker onPick={setOpponent} />
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

      <SubmitRow opponent={opponent} bestOf={bestOf} rated={rated} />
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
  opponent: Player
  onChange: () => void
}) {
  const guest = !!opponent.isGuest
  return (
    <div className={`nm-selected${guest ? ' guest' : ''}`}>
      <div className="av">{opponent.initials}</div>
      <div className="info">
        <div className="name">{opponent.name}</div>
        <div className="rating">
          {guest ? (
            'UNRATED GUEST'
          ) : (
            <>
              RATING · <b>{opponent.rating}</b> · {opponent.club}
            </>
          )}
        </div>
      </div>
      <button type="button" className="change" onClick={onChange}>
        Change
      </button>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Opponent — recent grid (default)                                  */
/* ------------------------------------------------------------------ */

function RecentPicker({ onPick }: { onPick: (player: Player) => void }) {
  const [showSearch, setShowSearch] = useState(false)
  const recents = PLAYERS.filter((p) => p.recent)

  if (showSearch) return <TypeaheadPicker onPick={onPick} />

  return (
    <div>
      <div className="nm-recent-label">
        <span>Recent</span>
        <button
          type="button"
          className="search-btn"
          onClick={() => setShowSearch(true)}
        >
          Search all players
        </button>
      </div>
      <div className="nm-recent-grid">
        {recents.map((p) => (
          <button
            type="button"
            key={p.id}
            className="nm-chip"
            onClick={() => onPick(p)}
          >
            <div className="av">{p.initials}</div>
            <div className="body">
              <div className="n">{p.name}</div>
              <div className="m">
                {p.rating} · {p.lastPlayed.toUpperCase()}
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Opponent — typeahead search                                       */
/* ------------------------------------------------------------------ */

function TypeaheadPicker({ onPick }: { onPick: (player: Player) => void }) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [activeIdx, setActiveIdx] = useState(0)
  const wrapRef = useRef<HTMLDivElement>(null)

  const filtered = useMemo(() => {
    if (!query.trim()) return PLAYERS.filter((p) => p.recent)
    const s = query.toLowerCase()
    return PLAYERS.filter(
      (p) =>
        p.name.toLowerCase().includes(s) || p.club.toLowerCase().includes(s),
    )
  }, [query])

  const results = useMemo(() => [...filtered, GUEST], [filtered])

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

  const showRecentHeader = !query.trim()
  const guestIdx = results.length - 1

  return (
    <div className="nm-search" ref={wrapRef}>
      <div className="nm-input-wrap">
        <Search className="search-icon" size={20} strokeWidth={1.75} />
        <input
          className="nm-input"
          placeholder="Search by name or club"
          value={query}
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
      {open && (
        <div className="nm-dropdown">
          {showRecentHeader && (
            <div className="nm-opt-section">
              Recent opponents <span className="line" />
            </div>
          )}
          {filtered.length === 0 && query && (
            <div className="nm-no-match">
              No one matches &ldquo;{query}&rdquo;. Try a different name.
            </div>
          )}
          {filtered.map((p, i) => (
            <button
              type="button"
              key={p.id}
              className={`nm-item${i === activeIdx ? ' active' : ''}`}
              onMouseEnter={() => setActiveIdx(i)}
              onClick={() => onPick(p)}
            >
              <div className="av">{p.initials}</div>
              <div className="body">
                <div className="n">{p.name}</div>
                <div className="m">
                  {p.club} · LAST PLAYED {p.lastPlayed.toUpperCase()}
                </div>
              </div>
              <div className="r">{p.rating}</div>
            </button>
          ))}
          <div className="nm-opt-section">
            Or <span className="line" />
          </div>
          <button
            type="button"
            className={`nm-item guest${activeIdx === guestIdx ? ' active' : ''}`}
            onMouseEnter={() => setActiveIdx(guestIdx)}
            onClick={() => onPick(GUEST)}
          >
            <div className="av">?</div>
            <div className="body">
              <div className="n">Log as guest</div>
              <div className="m">NO FORTYMM ACCOUNT · UNRATED</div>
            </div>
            <div className="r" style={{ color: 'var(--fg-muted)' }}>
              —
            </div>
          </button>
        </div>
      )}
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
            className={`nm-bestof-opt${bestOf === o.n ? ' active' : ''}`}
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
  opponent: Player | null
}) {
  const canRate = !opponent || !opponent.isGuest
  const effectiveRated = rated && canRate
  const ratedOpponent =
    opponent && !opponent.isGuest && opponent.rating != null ? opponent : null
  const delta =
    ratedOpponent && ratedOpponent.rating != null
      ? estimateDelta(ME.rating, ratedOpponent.rating)
      : null

  let description: string
  if (effectiveRated) {
    description =
      ratedOpponent && ratedOpponent.rating != null
        ? `Result will update both ratings. Based on a ${Math.abs(
            ratedOpponent.rating - ME.rating,
          )}-point gap.`
        : 'Pick a rated opponent to see the swing.'
  } else if (canRate) {
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
        {!canRate && <span className="na">Guest · unavailable</span>}
      </div>
      <div className="nm-rated">
        <button
          type="button"
          className={`nm-switch${effectiveRated ? ' on' : ''}`}
          role="switch"
          aria-checked={effectiveRated}
          aria-label="Rated match"
          disabled={!canRate}
          onClick={() => canRate && setRated(!rated)}
        />
        <div className="nm-rated-info">
          <div className="t">
            {effectiveRated ? 'Counts toward rating' : 'Just for fun'}
            {effectiveRated && delta != null && (
              <span className="delta">±{delta}</span>
            )}
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
}: {
  opponent: Player | null
  bestOf: number
  rated: boolean
}) {
  const hasOpponent = !!opponent && opponent.id !== 'tbd'
  const opponentName = opponent ? opponent.name : 'Opponent TBD'
  const effectivelyRated = rated && (!opponent || !opponent.isGuest)
  const gamesToWin = Math.ceil(bestOf / 2)
  const lengthCopy =
    bestOf === 1 ? 'Single game' : `Best of ${bestOf} · first to ${gamesToWin}`

  return (
    <div className="nm-summary">
      <div className="read">
        <div className="top">
          {hasOpponent ? (
            <>
              Ready: <b>You</b> vs <b>{opponentName}</b>
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
      </div>
      <div className="actions">
        {/* No backend yet — these actions are intentionally inert. */}
        <button type="button" className="nm-btn nm-btn-ghost">
          Cancel
        </button>
        <button type="button" className="nm-btn nm-btn-primary">
          Start match
          <ArrowRight size={16} strokeWidth={2.5} />
        </button>
      </div>
    </div>
  )
}
