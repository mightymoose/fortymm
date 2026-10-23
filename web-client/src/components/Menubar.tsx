import { useRef, useState, type FocusEvent, type KeyboardEvent } from 'react'
import { rowKeys } from './rowKeys'

// A desktop app's row of menus, as in the WAI-ARIA menubar pattern: a
// `.menubar` with role menubar, its items `.menubar-item` buttons with role
// menuitem (styles/base.css). The bar is one Tab stop. The arrow keys, Home
// and End move the focus along it, wrapping. Name it with `label`.
//
// `activeIndex` shows an item as active, as if under the pointer, while the
// bar doesn't have the focus, e.g. the menu that's open. It's also where
// the focus goes when the bar takes it, the first item unless given.
export function Menubar({
  label,
  items,
  activeIndex,
}: {
  label: string
  items: string[]
  activeIndex?: number
}) {
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const [tabStop, setTabStop] = useState(activeIndex ?? 0)
  const [focused, setFocused] = useState(false)

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    const move = rowKeys[event.key]
    if (!move) return
    event.preventDefault()
    itemRefs.current[move(index, items.length)]?.focus()
  }

  function onBlur(event: FocusEvent<HTMLDivElement>) {
    if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false)
  }

  return (
    <div
      role="menubar"
      aria-label={label}
      className="menubar"
      onFocus={() => setFocused(true)}
      onBlur={onBlur}
    >
      {items.map((item, index) => (
        <button
          key={item}
          ref={(button) => {
            itemRefs.current[index] = button
          }}
          type="button"
          role="menuitem"
          tabIndex={index === tabStop ? 0 : -1}
          className={
            !focused && index === activeIndex
              ? 'menubar-item menubar-item--active'
              : 'menubar-item'
          }
          onFocus={() => setTabStop(index)}
          onKeyDown={(event) => onKeyDown(event, index)}
        >
          {item}
        </button>
      ))}
    </div>
  )
}
