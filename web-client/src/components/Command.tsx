import { useId, useState, type KeyboardEvent } from 'react'
import type { MenuShortcut } from './Menu'

// One command in a Command palette. `id` must be unique in the palette and
// valid in an element id.
export type CommandItem = { id: string; label: string; shortcut?: MenuShortcut }

// A titled group of commands, e.g. "Recent".
export type CommandGroup = { heading: string; items: CommandItem[] }

// A command palette, as opened with ⌘K: a search input over a list of
// commands in titled groups, from the reference kit's Command. A `.cmd` box
// holding the `.cmd-input` row and a `.cmd-list` of groups, each a
// `.menu-label` over `.menu-item` options (styles/base.css). The input is a
// combobox and the list its listbox, both named by `label`. A command's
// shortcut shows in a `.kbd` and is read as its aria-keyshortcuts.
//
// The first command starts active. The up and down arrow keys and the
// pointer move the active command, wrapping, while the focus stays in the
// input. It's shown in place, open. It doesn't open or close, typing
// doesn't filter the list, and choosing a command does nothing yet.
export function Command({
  label,
  placeholder,
  groups,
}: {
  label: string
  placeholder?: string
  groups: CommandGroup[]
}) {
  const listId = useId()
  const items = groups.flatMap((group) => group.items)
  const [activeIndex, setActiveIndex] = useState(0)
  const optionId = (item: CommandItem) => `${listId}-${item.id}`
  const active = items[activeIndex]

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key]
    if (step === undefined) return
    // Natively the arrows would move the caret to the start or end.
    event.preventDefault()
    setActiveIndex((index) => (index + step + items.length) % items.length)
  }

  return (
    <div className="cmd">
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
          aria-label={label}
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={optionId(active)}
          autoComplete="off"
          placeholder={placeholder}
          onKeyDown={onKeyDown}
        />
      </div>
      <div className="cmd-list" role="listbox" id={listId} aria-label={label}>
        {groups.map((group, index) => (
          <div
            key={group.heading}
            role="group"
            aria-labelledby={`${listId}-group-${index}`}
          >
            <div
              role="presentation"
              id={`${listId}-group-${index}`}
              className="menu-label"
            >
              {group.heading}
            </div>
            {group.items.map((item) => (
              <div
                key={item.id}
                role="option"
                id={optionId(item)}
                aria-selected={item === active}
                aria-keyshortcuts={item.shortcut?.keys}
                className="menu-item"
                onPointerMove={() => setActiveIndex(items.indexOf(item))}
              >
                <span>{item.label}</span>
                {item.shortcut && (
                  <kbd className="kbd" aria-hidden="true">
                    {item.shortcut.label}
                  </kbd>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
