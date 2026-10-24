import {
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type MouseEvent,
  type Ref,
} from 'react'
import { Icon, type IconName } from './Icon'
import { ModalDialog } from './ModalDialog'

// One command in a CommandPalette. It's found by its label, hint and
// keywords, and listed under its group.
export type Command = {
  group: string
  label: string
  icon?: IconName
  hint?: string
  keywords?: string
  run: () => void
}

export type CommandPaletteHandle = {
  // Opens the palette with `query` typed in, or with no query.
  open: (query?: string) => void
}

// Lowercased with accents dropped, so "wojcik" finds "Wójcik".
function normalize(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

// A command palette, styled by `.fm-palette` in styles/kit.css, as kit.js's
// FM.palette draws it: a modal dialog with a search field over the
// commands that match it, in their groups. ↑ and ↓ move the active command,
// Enter or a click runs it, Esc closes. With `shortcut`, ⌘K or Ctrl+K opens
// and closes it from anywhere on the page. Open it with `open()` on its ref.
// It lists the commands `listCommands` returns as it opens, so they can
// follow the page.
export function CommandPalette({
  listCommands,
  shortcut = false,
  ref,
  ...props
}: Omit<ComponentProps<'dialog'>, 'ref'> & {
  listCommands: () => Command[]
  shortcut?: boolean
  ref?: Ref<CommandPaletteHandle>
}) {
  const id = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const [commands, setCommands] = useState<Command[]>([])
  const [query, setQuery] = useState('')
  const [chosen, setChosen] = useState(0)

  const typed = normalize(query.trim())
  const shown = commands.filter(
    (command) =>
      !typed ||
      normalize(`${command.label} ${command.hint ?? ''} ${command.keywords ?? ''}`).includes(
        typed,
      ),
  )
  const active = chosen < shown.length ? chosen : 0
  const optionPrefix = `${id}-o`
  const optionId = (index: number) => `${optionPrefix}${index}`

  function open(text = '') {
    setCommands(listCommands())
    setQuery(text)
    setChosen(0)
    if (!dialog.current?.open) dialog.current?.showModal()
    input.current?.focus()
  }

  useImperativeHandle(ref, () => ({ open }))

  useEffect(() => {
    if (!shortcut) return
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return
      event.preventDefault()
      if (dialog.current?.open) dialog.current.close()
      else open()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  })

  // Keeps the active command in view, with its group's title above it.
  useLayoutEffect(() => {
    const scroller = list.current
    const option = document.getElementById(optionId(active))
    if (!scroller || !option) return
    const top = option.offsetTop
    const bottom = top + option.offsetHeight
    if (top < scroller.scrollTop + 8) scroller.scrollTop = top - 30
    else if (bottom > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = bottom - scroller.clientHeight
    }
  })

  // Runs after the palette closes, so the command can move focus.
  function run(index: number) {
    const command = shown[index]
    if (!command) return
    dialog.current?.close()
    setTimeout(command.run, 0)
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const count = shown.length
    if (event.key === 'ArrowDown' && count) {
      event.preventDefault()
      setChosen((active + 1) % count)
    } else if (event.key === 'ArrowUp' && count) {
      event.preventDefault()
      setChosen((active - 1 + count) % count)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      run(active)
    }
  }

  const optionIndex = (event: MouseEvent<HTMLElement>) => {
    const option = (event.target as HTMLElement).closest<HTMLElement>('[role=option]')
    return option ? Number(option.id.slice(optionPrefix.length)) : -1
  }

  const groups: { name: string; first: number; commands: Command[] }[] = []
  shown.forEach((command, index) => {
    const last = groups[groups.length - 1]
    if (last?.name === command.group) last.commands.push(command)
    else groups.push({ name: command.group, first: index, commands: [command] })
  })

  return (
    <ModalDialog ref={dialog} className="fm-palette" aria-label="Command palette" {...props}>
      <div className="fm-palette__search">
        <Icon name="search" />
        <input
          ref={input}
          role="combobox"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-controls={`${id}-l`}
          aria-activedescendant={shown.length ? optionId(active) : undefined}
          aria-label="Search commands and players"
          placeholder="Type a command or player"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setChosen(0)
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      <div
        ref={list}
        className="fm-palette__list"
        id={`${id}-l`}
        role="listbox"
        aria-label="Commands"
        // Keeps focus in the search field.
        onPointerDown={(event) => event.preventDefault()}
        onClick={(event) => run(optionIndex(event))}
        onPointerMove={(event) => {
          const index = optionIndex(event)
          if (index >= 0 && index !== active) setChosen(index)
        }}
      >
        {shown.length ? (
          groups.map((group, groupIndex) => (
            <div key={group.first} role="group" aria-labelledby={`${id}-g${groupIndex}`}>
              <div className="fm-palette__group" id={`${id}-g${groupIndex}`} role="presentation">
                {group.name}
              </div>
              {group.commands.map((command, offset) => {
                const index = group.first + offset
                return (
                  <div
                    key={index}
                    className="fm-palette__opt"
                    role="option"
                    id={optionId(index)}
                    aria-selected={index === active}
                  >
                    {command.icon && <Icon name={command.icon} />}
                    <span>{command.label}</span>
                    {command.hint && <small>{command.hint}</small>}
                  </div>
                )
              })}
            </div>
          ))
        ) : (
          <div className="fm-combo__empty" role="presentation">
            No commands or players match “{query.trim()}”.
          </div>
        )}
      </div>
      <div className="fm-palette__foot" aria-hidden="true">
        <span>
          <span className="fm-kbd">↑</span> <span className="fm-kbd">↓</span> move
        </span>
        <span>
          <span className="fm-kbd">↵</span> run
        </span>
        <span>
          <span className="fm-kbd">esc</span> close
        </span>
      </div>
    </ModalDialog>
  )
}
