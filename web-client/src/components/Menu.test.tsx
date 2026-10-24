import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { Menu, type MenuEntry } from './Menu'

const entries: MenuEntry[] = [
  { kind: 'label', text: 'Match actions' },
  {
    kind: 'item',
    label: 'Rematch',
    shortcut: { label: '⌘ R', keys: 'Meta+R' },
  },
  { kind: 'checkbox', label: 'Show seeds', checked: true },
  { kind: 'separator' },
  { kind: 'item', label: 'Forfeit', destructive: true },
]

function items() {
  return [
    screen.getByRole('menuitem', { name: 'Rematch' }),
    screen.getByRole('menuitemcheckbox', { name: 'Show seeds' }),
    screen.getByRole('menuitem', { name: 'Forfeit' }),
  ]
}

describe('Menu', () => {
  it('renders a named menu of its entries, in order', () => {
    render(<Menu label="Match" entries={entries} />)

    const menu = screen.getByRole('menu', { name: 'Match' })
    expect(menu).toHaveClass('menu')
    expect(
      Array.from(menu.children, (child) => [
        child.getAttribute('role'),
        child.className,
        child.textContent,
      ]),
    ).toEqual([
      ['presentation', 'menu-label', 'Match actions'],
      ['menuitem', 'menu-item', 'Rematch⌘ R'],
      ['menuitemcheckbox', 'menu-item', '✓ Show seeds'],
      ['separator', 'menu-sep', ''],
      ['menuitem', 'menu-item menu-item--destructive', 'Forfeit'],
    ])
  })

  it("shows a shortcut, read as the item's key shortcut", () => {
    render(<Menu label="Match" entries={entries} />)

    const rematch = screen.getByRole('menuitem', { name: 'Rematch' })
    expect(rematch).toHaveAttribute('aria-keyshortcuts', 'Meta+R')
    expect(rematch.querySelector('kbd')).toHaveClass('kbd')
  })

  it('leads a checkbox item with ✓ while checked, two spaces otherwise', () => {
    render(
      <Menu
        label="Bracket"
        entries={[
          { kind: 'checkbox', label: 'Show seeds', checked: true },
          { kind: 'checkbox', label: 'Show ratings', checked: false },
        ]}
      />,
    )

    const seeds = screen.getByRole('menuitemcheckbox', { name: 'Show seeds' })
    const ratings = screen.getByRole('menuitemcheckbox', {
      name: 'Show ratings',
    })
    expect(seeds).toBeChecked()
    expect(seeds.textContent).toBe('✓ Show seeds')
    expect(ratings).not.toBeChecked()
    expect(ratings.textContent).toBe('\u00a0\u00a0Show ratings')
  })

  it('is one Tab stop, on the first item', async () => {
    const user = userEvent.setup()
    render(<Menu label="Match" entries={entries} />)

    expect(items().map((item) => item.tabIndex)).toEqual([0, -1, -1])
    await user.tab()
    expect(items()[0]).toHaveFocus()
  })

  it('moves the focus with the up and down arrows, wrapping, and Home and End', async () => {
    const user = userEvent.setup()
    render(<Menu label="Match" entries={entries} />)
    await user.tab()
    const [rematch, seeds, forfeit] = items()

    await user.keyboard('{ArrowDown}')
    expect(seeds).toHaveFocus()
    expect(items().map((item) => item.tabIndex)).toEqual([-1, 0, -1])
    await user.keyboard('{ArrowDown}')
    expect(forfeit).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(rematch).toHaveFocus()
    await user.keyboard('{ArrowUp}')
    expect(forfeit).toHaveFocus()
    await user.keyboard('{Home}')
    expect(rematch).toHaveFocus()
    await user.keyboard('{End}')
    expect(forfeit).toHaveFocus()
  })
})
