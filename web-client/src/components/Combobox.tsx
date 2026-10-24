import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type Ref,
} from 'react'
import { useAnnounce } from './announceContext'
import { Icon } from './Icon'

// A player the combobox lists. The club and rating tell same-name players
// apart.
export type ComboboxOption = { name: string; club?: string; rating?: string }

export type ComboboxHandle = {
  // Types `text` into the field, focuses it and lists what it finds.
  search: (text: string) => void
}

// How long the result count waits before it's read out, so it isn't read
// for every key.
export const ANNOUNCE_DELAY_MS = 500

// Lowercased with accents dropped, so "wojcik" finds "Wójcik".
function normalize(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

// `name` with the first match of `query` in bold.
function highlight(name: string, query: string): ReactNode {
  const at = query ? normalize(name).indexOf(query) : -1
  if (at < 0) return name
  return (
    <>
      {name.slice(0, at)}
      <mark>{name.slice(at, at + query.length)}</mark>
      {name.slice(at + query.length)}
    </>
  )
}

// A searchable player picker, styled by `.fm-combo` in styles/kit.css, as
// kit.js's combobox draws it: an ARIA 1.2 combobox with a list that filters
// as you type. It matches the name or the club, ignoring accents. ↓ and ↑
// move, Enter picks, Esc closes the list and a second Esc clears the field.
// `id` is the field's, for its <label>, and `label` names the list.
export function Combobox({
  id,
  label,
  options,
  placeholder,
  'aria-describedby': describedBy,
  onChange,
  ref,
  ...props
}: Omit<ComponentProps<'div'>, 'onChange' | 'ref'> & {
  id: string
  label: string
  options: readonly ComboboxOption[]
  placeholder?: string
  onChange?: (option: ComboboxOption) => void
  ref?: Ref<ComboboxHandle>
}) {
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const announce = useAnnounce()
  const [text, setText] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [chosen, setChosen] = useState<ComboboxOption | null>(null)

  const listId = `${id}-list`
  const optionId = (index: number) => `${id}-o${index}`
  const query = normalize(text.trim())
  const found = options.filter(
    (option) =>
      !query || normalize(option.name).includes(query) || normalize(option.club ?? '').includes(query),
  )

  function type(value: string) {
    setText(value)
    setChosen(null)
    setActive(value.trim() ? 0 : -1)
    setOpen(true)
  }

  useImperativeHandle(ref, () => ({
    search: (value) => {
      input.current?.focus()
      type(value)
    },
  }))

  function close() {
    setOpen(false)
    setActive(-1)
  }

  function pick(index: number) {
    const option = found[index]
    if (!option) return
    setChosen(option)
    setText(option.name)
    close()
    onChange?.(option)
  }

  // Keeps the active option in view.
  useLayoutEffect(() => {
    const scroller = list.current
    const option = open && active >= 0 ? document.getElementById(optionId(active)) : null
    if (!scroller || !option) return
    const top = option.offsetTop
    const bottom = top + option.offsetHeight
    if (top < scroller.scrollTop) scroller.scrollTop = top
    else if (bottom > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = bottom - scroller.clientHeight
    }
  })

  const count = found.length
  useEffect(() => {
    if (!open) return
    const timer = setTimeout(
      () =>
        announce(count ? `${count} player${count > 1 ? 's' : ''} found` : 'No players found'),
      ANNOUNCE_DELAY_MS,
    )
    return () => clearTimeout(timer)
  }, [open, text, active, count, announce])

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (!open) {
        setOpen(true)
        setActive(0)
      } else if (count) setActive((active + 1) % count)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) {
        setOpen(true)
        setActive(count - 1)
      } else if (count) setActive((active - 1 + count) % count)
    } else if (event.key === 'Enter') {
      if (open && active >= 0) {
        event.preventDefault()
        pick(active)
      }
    } else if (event.key === 'Escape') {
      if (open) {
        event.preventDefault()
        close()
      } else if (text) {
        setText('')
        setChosen(null)
      }
    } else if (event.key === 'Tab') {
      close()
    }
  }

  const optionIndex = (event: MouseEvent<HTMLElement>) => {
    const option = (event.target as HTMLElement).closest<HTMLElement>('[role=option]')
    return option ? Number(option.id.slice(`${id}-o`.length)) : -1
  }

  return (
    <div className="fm-combo" {...props}>
      <Icon name="search" />
      <input
        ref={input}
        id={id}
        className="fm-input"
        placeholder={placeholder}
        aria-describedby={describedBy}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
        autoComplete="off"
        value={text}
        onChange={(event) => type(event.target.value)}
        onClick={() => {
          if (!open) setOpen(true)
        }}
        onKeyDown={onKeyDown}
        onBlur={() => setTimeout(close, 0)}
      />
      <ul
        ref={list}
        className="fm-overlay fm-combo__list"
        id={listId}
        role="listbox"
        aria-label={label}
        hidden={!open}
        // Keeps focus in the field.
        onPointerDown={(event) => event.preventDefault()}
        onClick={(event) => pick(optionIndex(event))}
        onPointerMove={(event) => {
          const index = optionIndex(event)
          if (index >= 0 && index !== active) setActive(index)
        }}
      >
        {count ? (
          found.map((option, index) => (
            <li
              key={`${option.name} ${option.club}`}
              className="fm-combo__opt"
              role="option"
              id={optionId(index)}
              aria-selected={index === active}
            >
              <span className="ck">
                {chosen === option && <Icon name="check" className="fm-ic--sm" />}
              </span>
              <b>{highlight(option.name, query)}</b>
              {option.club && <small>{option.club}</small>}
              {option.rating && (
                <span className="r" aria-label={`rating ${option.rating}`}>
                  {option.rating}
                </span>
              )}
            </li>
          ))
        ) : (
          <li className="fm-combo__empty" role="presentation">
            No players match “{text.trim()}”. Check the spelling or search by club.
          </li>
        )}
      </ul>
    </div>
  )
}
