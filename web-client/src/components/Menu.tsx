import { useRef, useState, type KeyboardEvent } from 'react'
import { columnKeys } from './rowKeys'

// A shortcut as shown, e.g. "⌘ R", and as aria-keyshortcuts reads it, e.g.
// "Meta+R".
export type MenuShortcut = { label: string; keys: string }

// One row of a Menu: a label over the items after it, an item, an item that
// toggles on and off, or a line between groups of items.
export type MenuEntry =
  | { kind: 'label'; text: string }
  | {
      kind: 'item'
      label: string
      shortcut?: MenuShortcut
      destructive?: boolean
    }
  | { kind: 'checkbox'; label: string; checked: boolean }
  | { kind: 'separator' }

function focusable(entry: MenuEntry): boolean {
  return entry.kind === 'item' || entry.kind === 'checkbox'
}

// An open menu, as in the WAI-ARIA menu pattern, e.g. a dropdown or a
// right-click menu: a `.menu` with role menu, named by `label`, holding its
// entries (styles/base.css). Items are `.menu-item`s with role menuitem, a
// shortcut shown in a `.kbd` beside them. Checkbox items have role
// menuitemcheckbox, led by ✓ while checked and two spaces otherwise, as
// the reference kit draws them. Labels are `.menu-label`s and separators
// `.menu-sep`s.
//
// The menu is one Tab stop. The up and down arrow keys, Home and End move
// the focus through its items, wrapping. It's shown in place, open. It
// doesn't open or close. Choosing an item, or toggling a checkbox item,
// does nothing yet.
export function Menu({
  label,
  entries,
}: {
  label: string
  entries: MenuEntry[]
}) {
  const [tabStop, setTabStop] = useState(0)
  const itemRefs = useRef<(HTMLDivElement | null)[]>([])
  const itemCount = entries.filter(focusable).length

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>, index: number) {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    const move = columnKeys[event.key]
    if (!move) return
    event.preventDefault()
    itemRefs.current[move(index, itemCount)]?.focus()
  }

  // Each focusable entry's place among the items, for the focus moves.
  let itemIndex = 0
  return (
    <div role="menu" aria-label={label} className="menu">
      {entries.map((entry, key) => {
        if (entry.kind === 'label') {
          return (
            <div key={key} role="presentation" className="menu-label">
              {entry.text}
            </div>
          )
        }
        if (entry.kind === 'separator') {
          return <div key={key} role="separator" className="menu-sep" />
        }
        const index = itemIndex++
        const itemProps = {
          ref: (item: HTMLDivElement | null) => {
            itemRefs.current[index] = item
          },
          tabIndex: index === tabStop ? 0 : -1,
          onFocus: () => setTabStop(index),
          onKeyDown: (event: KeyboardEvent<HTMLDivElement>) =>
            onKeyDown(event, index),
        }
        if (entry.kind === 'checkbox') {
          return (
            <div
              key={key}
              role="menuitemcheckbox"
              aria-checked={entry.checked}
              className="menu-item"
              {...itemProps}
            >
              <span>
                <span className="menu-check" aria-hidden="true">
                  {entry.checked ? '✓ ' : '\u00a0\u00a0'}
                </span>
                {entry.label}
              </span>
            </div>
          )
        }
        return (
          <div
            key={key}
            role="menuitem"
            aria-keyshortcuts={entry.shortcut?.keys}
            className={
              entry.destructive
                ? 'menu-item menu-item--destructive'
                : 'menu-item'
            }
            {...itemProps}
          >
            <span>{entry.label}</span>
            {entry.shortcut && (
              <kbd className="kbd" aria-hidden="true">
                {entry.shortcut.label}
              </kbd>
            )}
          </div>
        )
      })}
    </div>
  )
}
