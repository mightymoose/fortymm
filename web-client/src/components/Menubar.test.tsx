import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Menubar, type MenubarMenu } from './Menubar'

const menus: readonly MenubarMenu[] = [
  { label: 'File', items: [{ label: 'Open' }, { label: 'Print', shortcut: '⌘P' }] },
  { label: 'Edit', items: [{ label: 'Undo' }, 'divider', { label: 'Delete all', danger: true }] },
  { label: 'View', items: [{ label: 'Zoom in' }, { label: 'Zoom out' }] },
]

function renderMenubar() {
  const onChoose = vi.fn()
  render(
    <>
      <button type="button">Before</button>
      <Menubar label="Tools" menus={menus} onChoose={onChoose} />
      <button type="button">After</button>
    </>,
  )
  return onChoose
}

// The bar's item for the menu `name`, and the command `name` in the open
// menu. Both are menu items, and no menu shares a name with a command.
const top = (name: string | RegExp) => screen.getByRole('menuitem', { name })
const command = top
const openMenu = () => screen.queryByRole('menu')

describe('Menubar', () => {
  it('is one tab stop, on its first menu', async () => {
    const user = userEvent.setup()
    renderMenubar()

    await user.click(screen.getByRole('button', { name: 'Before' }))
    await user.tab()
    expect(top('File')).toHaveFocus()
    await user.tab()

    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus()
  })

  it('moves between its menus with ← and →, wrapping at the ends', async () => {
    const user = userEvent.setup()
    renderMenubar()
    top('File').focus()

    await user.keyboard('{ArrowLeft}')
    expect(top('View')).toHaveFocus()
    await user.keyboard('{ArrowRight}{ArrowRight}')

    expect(top('Edit')).toHaveFocus()
    expect(openMenu()).toBeNull()
  })

  it('opens a menu at its first command with ↓ or Enter, and at its last with ↑', async () => {
    const user = userEvent.setup()
    renderMenubar()
    top('File').focus()

    await user.keyboard('{ArrowDown}')
    expect(openMenu()).toHaveAccessibleName('File')
    expect(top('File')).toHaveAttribute('aria-expanded', 'true')
    expect(command('Open')).toHaveFocus()

    await user.keyboard('{Escape}{ArrowRight}{Enter}')
    expect(openMenu()).toHaveAccessibleName('Edit')
    expect(command('Undo')).toHaveFocus()

    await user.keyboard('{Escape}{ArrowUp}')
    expect(command('Delete all')).toHaveFocus()
  })

  it('moves inside a menu with ↑ and ↓, and to the next menu with →', async () => {
    const user = userEvent.setup()
    renderMenubar()
    top('File').focus()
    await user.keyboard('{Enter}')

    await user.keyboard('{ArrowUp}')
    expect(command(/^Print/)).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(command('Open')).toHaveFocus()

    await user.keyboard('{ArrowRight}')
    expect(openMenu()).toHaveAccessibleName('Edit')
    expect(command('Undo')).toHaveFocus()
  })

  it('closes with Esc and puts focus back on its menu', async () => {
    const user = userEvent.setup()
    renderMenubar()
    top('File').focus()
    await user.keyboard('{ArrowRight}{Enter}')

    await user.keyboard('{Escape}')

    expect(openMenu()).toBeNull()
    expect(top('Edit')).toHaveFocus()
    expect(top('Edit')).toHaveAttribute('aria-expanded', 'false')
  })

  it('chooses a command, closes the menu and says which', async () => {
    const user = userEvent.setup()
    const onChoose = renderMenubar()

    await user.click(top('Edit'))
    await user.click(command('Delete all'))

    expect(openMenu()).toBeNull()
    expect(onChoose).toHaveBeenCalledWith(menus[1], { label: 'Delete all', danger: true })
  })

  it('closes on a click outside it', async () => {
    const user = userEvent.setup()
    const onChoose = renderMenubar()
    await user.click(top('View'))
    expect(openMenu()).toHaveAccessibleName('View')

    await user.click(screen.getByRole('button', { name: 'After' }))

    expect(openMenu()).toBeNull()
    expect(onChoose).not.toHaveBeenCalled()
  })

  it('switches to the menu the pointer moves onto while one is open', async () => {
    const user = userEvent.setup()
    renderMenubar()
    await user.click(top('File'))

    await user.hover(top('View'))

    expect(openMenu()).toHaveAccessibleName('View')
  })
})
