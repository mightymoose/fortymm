import { useRef, type KeyboardEvent } from 'react'
import type { ForcedState } from '../forced-state.ts'
import './Menu.css'

export type MenuItem =
  | {
      label: string
      // The item's keyboard shortcut, shown at its end.
      shortcut?: string
      // A destructive item ("Withdraw player…"), in --danger.
      danger?: boolean
      onSelect?: () => void
      forcedState?: Extract<ForcedState, 'hover'>
    }
  | 'separator'

// The design system's menu (.fm-menu): a list of actions on one thing, in an
// overlay. role="menu", named by `label`, its items role="menuitem". One
// stop in the tab order: the arrow keys move between the items (Home and
// End to the first and last). Where it opens and when it closes is the
// screen's to decide; this is the menu itself.
export function Menu({ label, items }: { label: string; items: MenuItem[] }) {
  const menuRef = useRef<HTMLDivElement>(null)

  function move(event: KeyboardEvent<HTMLDivElement>) {
    const buttons = [
      ...(menuRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]',
      ) ?? []),
    ]
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const to = {
      ArrowDown: (at + 1) % buttons.length,
      ArrowUp: (at - 1 + buttons.length) % buttons.length,
      Home: 0,
      End: buttons.length - 1,
    }[event.key]
    if (to === undefined) return
    event.preventDefault()
    buttons[to]?.focus()
  }

  // The first item is the menu's stop in the tab order.
  const firstItem = items.findIndex((item) => item !== 'separator')
  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={label}
      className="menu"
      onKeyDown={move}
    >
      {items.map((item, index) => {
        if (item === 'separator') return <hr key={`separator-${index}`} />
        return (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            tabIndex={index === firstItem ? 0 : -1}
            className={
              item.danger ? 'menu__item menu__item--danger' : 'menu__item'
            }
            aria-keyshortcuts={item.shortcut}
            data-forced-state={item.forcedState}
            onClick={item.onSelect}
          >
            {item.label}
            {item.shortcut !== undefined && (
              <small aria-hidden="true">{item.shortcut}</small>
            )}
          </button>
        )
      })}
    </div>
  )
}
