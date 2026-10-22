import {
  useId,
  useReducer,
  type ChangeEvent,
  type ComponentProps,
  type FocusEvent,
  type KeyboardEvent,
} from 'react'
import { useField, useFieldControl } from './fieldContext'

// One choice in a Combobox. `label` is what the query filters and what
// choosing it writes into the input. `hint` is shown beside it in mono, e.g.
// a player's rating. `id` must be unique in the options and valid in an
// element id.
export type ComboboxOption = { id: string; label: string; hint?: string }

type ComboboxState = {
  query: string
  list: { open: false } | { open: true; activeId: string | null }
}

// Each action that moves the active option carries the ids of the options
// its query matches, so the active option is always one that's shown.
type ComboboxAction =
  | { type: 'typed'; query: string; matchIds: string[] }
  | { type: 'moved'; step: number; matchIds: string[] }
  | { type: 'pointed'; id: string }
  | { type: 'chose'; label: string }
  | { type: 'closed' }

function reducer(state: ComboboxState, action: ComboboxAction): ComboboxState {
  switch (action.type) {
    case 'typed':
      return {
        query: action.query,
        list: { open: true, activeId: action.matchIds[0] ?? null },
      }
    // A closed list opens on its first match (down) or its last (up).
    case 'moved': {
      const { step, matchIds } = action
      if (matchIds.length === 0) return state
      const at = state.list.open && state.list.activeId !== null
        ? matchIds.indexOf(state.list.activeId)
        : -1
      const next = at === -1
        ? (step > 0 ? 0 : matchIds.length - 1)
        : (at + step + matchIds.length) % matchIds.length
      return { ...state, list: { open: true, activeId: matchIds[next] } }
    }
    case 'pointed':
      if (!state.list.open || state.list.activeId === action.id) return state
      return { ...state, list: { open: true, activeId: action.id } }
    case 'chose':
      return { query: action.label, list: { open: false } }
    case 'closed':
      return state.list.open ? { ...state, list: { open: false } } : state
  }
}

// The options whose label holds the query, ignoring case. A hint never
// matches, so "16" doesn't find a 1620 rating.
function matching(options: ComboboxOption[], query: string): ComboboxOption[] {
  const needle = query.toLowerCase()
  return options.filter((option) => option.label.toLowerCase().includes(needle))
}

// A text input that filters a list of options as the user types, from the
// reference kit's Command: a `.cmd` box holding the `.cmd-input` row and a
// `.cmd-list` of `.menu-item` options (styles/base.css). The input is a
// combobox and the list its listbox. The active option follows the arrow keys
// and the pointer, and Enter or a click chooses it: its label goes into the
// input, the list closes and `onValueChange` gets the option. Escape and
// leaving the input close the list.
//
// It's uncontrolled: `defaultQuery` fills the input, and `defaultOpen` opens
// the list on its first match. `className` adds to the box's class, and the
// other props go to the input.
//
// Inside a Field it's wired to the field's label, help text and every state,
// as a text input is, since the control is one. Its list is named as the
// input is.
export function Combobox({
  options,
  defaultQuery = '',
  defaultOpen = false,
  onValueChange,
  className,
  onChange,
  onKeyDown,
  onBlur,
  ...props
}: Omit<
  ComponentProps<'input'>,
  'value' | 'defaultValue' | 'type' | 'role'
> & {
  options: ComboboxOption[]
  defaultQuery?: string
  defaultOpen?: boolean
  onValueChange?: (option: ComboboxOption) => void
}) {
  const [state, dispatch] = useReducer(
    reducer,
    undefined,
    (): ComboboxState => ({
      query: defaultQuery,
      list: defaultOpen
        ? {
            open: true,
            activeId: matching(options, defaultQuery)[0]?.id ?? null,
          }
        : { open: false },
    }),
  )
  const inputProps = useFieldControl(props)
  const field = useField()
  const listId = useId()
  const optionId = (option: ComboboxOption) => `${listId}-${option.id}`

  const matches = matching(options, state.query)
  const matchIds = matches.map((option) => option.id)
  const expanded =
    state.list.open && matches.length > 0 && !inputProps.disabled
  const activeId = expanded && state.list.open ? state.list.activeId : null
  const active = matches.find((option) => option.id === activeId)

  function choose(option: ComboboxOption) {
    dispatch({ type: 'chose', label: option.label })
    onValueChange?.(option)
  }

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const query = event.target.value
    dispatch({
      type: 'typed',
      query,
      matchIds: matching(options, query).map((option) => option.id),
    })
    onChange?.(event)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    onKeyDown?.(event)
    if (event.defaultPrevented || inputProps.disabled) return
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key]
    if (step !== undefined && matches.length > 0) {
      // Natively the arrows would move the caret to the start or end.
      event.preventDefault()
      dispatch({ type: 'moved', step, matchIds })
    } else if (event.key === 'Enter' && active) {
      event.preventDefault()
      choose(active)
    } else if (event.key === 'Escape' && expanded) {
      event.preventDefault()
      dispatch({ type: 'closed' })
    }
  }

  function handleBlur(event: FocusEvent<HTMLInputElement>) {
    dispatch({ type: 'closed' })
    onBlur?.(event)
  }

  const ownName = props['aria-label'] || props['aria-labelledby']
  return (
    <div className={className ? `cmd ${className}` : 'cmd'}>
      <div className="cmd-input">
        <svg
          aria-hidden="true"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="M21 21l-4-4" />
        </svg>
        <input
          role="combobox"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active ? optionId(active) : undefined}
          autoComplete="off"
          {...inputProps}
          value={state.query}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
        />
      </div>
      <div
        className="cmd-list"
        role="listbox"
        id={listId}
        hidden={!expanded}
        aria-label={ownName ? props['aria-label'] : undefined}
        aria-labelledby={
          ownName ? props['aria-labelledby'] : field?.labelId
        }
      >
        {matches.map((option) => (
          <div
            key={option.id}
            className="menu-item"
            role="option"
            id={optionId(option)}
            aria-selected={option === active}
            // Keeps the focus in the input, so choosing doesn't close the
            // list first.
            onMouseDown={(event) => event.preventDefault()}
            onPointerMove={() => dispatch({ type: 'pointed', id: option.id })}
            onClick={() => choose(option)}
          >
            {option.label}
            {option.hint !== undefined && (
              <>
                {' '}
                <span className="menu-item-hint">{option.hint}</span>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
