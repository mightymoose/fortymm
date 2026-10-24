import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { Menu, type MenuCommand, type MenuItems } from './Menu'

// A menu of the bar: its name on the bar, then its commands.
export type MenubarMenu = { label: string; items: MenuItems }

// Which menu is open, and which of its commands takes focus once it shows.
type Opened = { menu: number; focus: 'first' | 'last' }

// A row of menus for dense desktop tools, as kit.js's FM.menubar has it,
// styled by `.fm-menubar` and `.fm-menu` in styles/kit.css. Only one item
// on the bar is a tab stop. ← and → move between the menus, and an open
// menu follows. ↓, Enter or Space opens one at its first command, ↑ at its
// last, ↑ and ↓ move inside, and Esc closes it back to the bar. Choosing a
// command closes the menu and calls `onChoose` with the menu and command.
export function Menubar({
  label,
  menus,
  onChoose,
}: {
  label: string
  menus: readonly MenubarMenu[]
  onChoose: (menu: MenubarMenu, command: MenuCommand) => void
}) {
  const id = useId()
  const [current, setCurrent] = useState(0)
  const [opened, setOpened] = useState<Opened | null>(null)
  const bar = useRef<HTMLUListElement>(null)
  const tops = useRef<(HTMLButtonElement | null)[]>([])
  const lists = useRef<(HTMLDivElement | null)[]>([])

  const commandsOf = (menu: number) => [
    ...(lists.current[menu]?.querySelectorAll<HTMLButtonElement>('[role=menuitem]') ?? []),
  ]

  // A menu's commands can take focus only once it's no longer hidden.
  useEffect(() => {
    if (!opened) return
    const commands = commandsOf(opened.menu)
    commands[opened.focus === 'first' ? 0 : commands.length - 1]?.focus()
  }, [opened])

  useEffect(() => {
    if (!opened) return
    const closeOutside = (event: PointerEvent) => {
      if (!bar.current?.contains(event.target as Node)) setOpened(null)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [opened])

  const wrap = (menu: number) => (menu + menus.length) % menus.length

  const open = (menu: number, focus: Opened['focus'] = 'first') => {
    setCurrent(menu)
    setOpened({ menu, focus })
  }

  const close = (focusTop: boolean) => {
    if (!opened) return
    setOpened(null)
    if (focusTop) tops.current[opened.menu]?.focus()
  }

  const step = (menu: number) => {
    if (opened) return open(menu)
    setCurrent(menu)
    tops.current[menu]?.focus()
  }

  const onTopKeyDown = (event: KeyboardEvent, menu: number) => {
    const keys: Record<string, () => void> = {
      ArrowRight: () => step(wrap(menu + 1)),
      ArrowLeft: () => step(wrap(menu - 1)),
      ArrowDown: () => open(menu),
      Enter: () => open(menu),
      ' ': () => open(menu),
      ArrowUp: () => open(menu, 'last'),
      Home: () => step(0),
      End: () => step(menus.length - 1),
      Escape: () => close(true),
    }
    const action = keys[event.key]
    if (!action) return
    // Enter and Space would also click the item, which closes what they open.
    event.preventDefault()
    action()
  }

  const onCommandKeyDown = (event: KeyboardEvent, menu: number) => {
    const commands = commandsOf(menu)
    const at = commands.indexOf(event.target as HTMLButtonElement)
    const keys: Record<string, () => void> = {
      ArrowDown: () => commands[(at + 1) % commands.length].focus(),
      ArrowUp: () => commands[(at - 1 + commands.length) % commands.length].focus(),
      Home: () => commands[0].focus(),
      End: () => commands[commands.length - 1].focus(),
      Escape: () => close(true),
      ArrowRight: () => open(wrap(menu + 1)),
      ArrowLeft: () => open(wrap(menu - 1)),
    }
    const action = keys[event.key]
    if (action) {
      event.preventDefault()
      action()
    } else if (event.key === 'Tab') {
      close(false)
    }
  }

  return (
    <ul className="fm-menubar" role="menubar" aria-label={label} ref={bar}>
      {menus.map((menu, index) => {
        const listId = `${id}-menu${index}`
        const isOpen = opened?.menu === index
        return (
          <li key={menu.label} role="none">
            <button
              type="button"
              className="fm-menubar__top"
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={isOpen}
              aria-controls={listId}
              tabIndex={index === current ? 0 : -1}
              ref={(top) => {
                tops.current[index] = top
              }}
              onKeyDown={(event) => onTopKeyDown(event, index)}
              onClick={() => (isOpen ? close(true) : open(index))}
              onPointerOver={() => {
                if (opened && !isOpen) open(index)
              }}
            >
              {menu.label}
            </button>
            <Menu
              label={menu.label}
              items={menu.items}
              id={listId}
              hidden={!isOpen}
              ref={(list) => {
                lists.current[index] = list
              }}
              commandProps={(command) => ({
                tabIndex: -1,
                onKeyDown: (event) => onCommandKeyDown(event, index),
                onClick: () => {
                  close(true)
                  onChoose(menu, command)
                },
              })}
            />
          </li>
        )
      })}
    </ul>
  )
}
