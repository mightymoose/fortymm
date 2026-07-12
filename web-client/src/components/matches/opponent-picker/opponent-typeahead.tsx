import {
  useEffect,
  useId,
  useRef,
  useState,
  type MutableRefObject,
} from 'react'
import { Search } from 'lucide-react'

import { usePlayerSearch, type Player } from '@/api/matches'
import { useDebouncedValue } from '@/lib/use-debounced-value'

import { OpponentOption } from './opponent-typeahead/opponent-option'

export interface OpponentTypeaheadProps {
  /**
   * Current search text. Owned by `OpponentPicker` above the error boundary so
   * a failed-search retry preserves it (#96).
   */
  query: string
  /** Update the (lifted) query. */
  onQueryChange: (query: string) => void
  /** Select a player from the results. */
  onPick: (player: Player) => void
  /**
   * Focus the input once on first open. The ref is owned above the boundary and
   * cleared after the first focus, so an error-recovery remount doesn't yank
   * focus back to the input (#131). Optional so the component renders standalone.
   */
  focusOnMountRef?: MutableRefObject<boolean>
}

/**
 * The opponent search typeahead, built to the ARIA 1.2 combobox pattern (#94):
 * a `role="combobox"` input controlling a `role="listbox"` of
 * `role="option"` rows, with `aria-activedescendant` tracking the
 * keyboard-highlighted option. Supports Arrow / Home / End / Enter / Escape
 * (#97/#100) and never steals focus on a remount (#131).
 *
 * **Highlight is not selection (#894).** `activeIdx` is `null` until the user
 * arrows to a row or moves the cursor over one — merely *matching* a search is
 * not a choice, so no row is pre-highlighted when results land (and the
 * highlight is dropped again on the next keystroke). The highlight reaches
 * assistive tech only as this combobox's `aria-activedescendant`; the options
 * themselves stay `aria-selected="false"`, because nothing here is selected
 * until a pick is committed to the card above.
 */
export const OpponentTypeahead = ({
  query,
  onQueryChange,
  onPick,
  focusOnMountRef,
}: OpponentTypeaheadProps) => {
  // Open on mount: the typeahead is only mounted once the user has chosen to
  // search, so the dropdown (hint, then results) should show straight away.
  const [open, setOpen] = useState(true)
  // `null` = no option highlighted. The two cases are mutually exclusive, and a
  // sentinel index (0, or -1) is what let the old picker announce row 1 as
  // chosen the instant results arrived (#894).
  const [activeIdx, setActiveIdx] = useState<number | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listboxId = useId()

  // Trimmed and debounced; the (already-trimmed) term is the React Query key,
  // so each search lands in its own cache slot.
  const term = useDebouncedValue(query, 250).trim()
  const { data: results = [], isFetching } = usePlayerSearch(term)

  // Imperative focus-on-first-open instead of `autoFocus`, which fires on every
  // mount including error-boundary resets (#131).
  useEffect(() => {
    if (focusOnMountRef?.current) {
      focusOnMountRef.current = false
      inputRef.current?.focus()
    }
  }, [focusOnMountRef])

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
    onQueryChange(value)
    // Still hunting: drop the highlight rather than re-arm it onto whoever the
    // next result set happens to put in that slot (#894).
    setActiveIdx(null)
    setOpen(true)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    // ArrowDown reopens a listbox that Escape dismissed without clearing the
    // query (#97) — so the input is never a dead end. Arrowing *is* intent, so
    // it enters the list at the top rather than reopening to no highlight.
    if (e.key === 'ArrowDown' && !open) {
      e.preventDefault()
      setOpen(true)
      setActiveIdx(results.length > 0 ? 0 : null)
      return
    }
    if (!open) return

    const last = results.length - 1
    const hasResults = results.length > 0
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        // Entering the list from no highlight lands on the first option.
        if (hasResults) {
          setActiveIdx((i) => (i === null ? 0 : Math.min(last, i + 1)))
        }
        break
      case 'ArrowUp':
        e.preventDefault()
        // …and from no highlight, ArrowUp enters it from the bottom.
        if (hasResults) {
          setActiveIdx((i) => (i === null ? last : Math.max(0, i - 1)))
        }
        break
      case 'Home':
        // Jump to the first option (#100).
        if (hasResults) {
          e.preventDefault()
          setActiveIdx(0)
        }
        break
      case 'End':
        // Jump to the last option (#100).
        if (hasResults) {
          e.preventDefault()
          setActiveIdx(last)
        }
        break
      case 'Enter': {
        e.preventDefault()
        // Enter commits the highlighted option — with none highlighted it
        // commits nobody, instead of quietly picking whoever is first (#894).
        const picked = activeIdx === null ? undefined : results[activeIdx]
        if (picked) onPick(picked)
        break
      }
      case 'Escape':
        // Keep the typed query, only hide the listbox (#97). ArrowDown or the
        // next keystroke reopens it.
        e.preventDefault()
        setOpen(false)
        break
    }
  }

  // `placeholderData` on the search query keeps the prior term's rows visible
  // while the next term loads, so this only fires on the very first search.
  const loadingFirstResults = isFetching && results.length === 0
  const optionId = (i: number) => `${listboxId}-opt-${i}`
  // Only ever points at a row the user actually highlighted, and only at one
  // that is still on screen (a stale index can outlive its result set).
  const activeDescendant =
    open && activeIdx !== null && results[activeIdx]
      ? optionId(activeIdx)
      : undefined

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
    return (
      <div role="listbox" id={listboxId} aria-label="Player results">
        {results.map((p, i) => (
          <OpponentOption
            key={p.id}
            id={optionId(i)}
            player={p}
            active={i === activeIdx}
            onPick={() => onPick(p)}
            onHover={() => setActiveIdx(i)}
          />
        ))}
      </div>
    )
  }

  return (
    <div className="nm-search" ref={wrapRef}>
      <div className="nm-input-wrap">
        <Search
          className="search-icon"
          size={20}
          strokeWidth={1.75}
          aria-hidden="true"
        />
        <input
          ref={inputRef}
          className="nm-input"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-activedescendant={activeDescendant}
          aria-label="Search players by username"
          placeholder="Search by username"
          value={query}
          onChange={(e) => changeQuery(e.target.value)}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        {query && (
          <button
            type="button"
            className="nm-clear"
            aria-label="Clear search"
            onClick={() => {
              changeQuery('')
              inputRef.current?.focus()
            }}
          >
            ×
          </button>
        )}
      </div>
      {open && <div className="nm-dropdown">{renderBody()}</div>}
    </div>
  )
}
