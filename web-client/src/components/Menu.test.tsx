import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { Menu, type MenuItem } from './Menu.tsx'

const items: MenuItem[] = [
  { label: 'Call to table', shortcut: 'C' },
  { label: 'Move to another table', shortcut: 'M' },
  'separator',
  { label: 'Withdraw player…', danger: true },
]

const item = (name: string) => screen.getByRole('menuitem', { name })

test('a menu is named by its label, an item per action, the separator between them', () => {
  render(<Menu label="Match actions" items={items} />)

  expect(screen.getByRole('menu', { name: 'Match actions' })).toBeVisible()
  expect(screen.getAllByRole('menuitem')).toHaveLength(3)
  expect(screen.getByRole('separator')).toBeInTheDocument()
  expect(item('Call to table')).toHaveAttribute('aria-keyshortcuts', 'C')
})

test('a menu is one stop in the tab order, and the arrow keys move between its items', async () => {
  const user = userEvent.setup()
  render(<Menu label="Match actions" items={items} />)

  await user.tab()
  expect(item('Call to table')).toHaveFocus()
  await user.keyboard('{ArrowDown}')
  expect(item('Move to another table')).toHaveFocus()
  await user.keyboard('{ArrowDown}')
  expect(item('Withdraw player…')).toHaveFocus()
  await user.keyboard('{ArrowDown}')
  expect(item('Call to table')).toHaveFocus()
  await user.keyboard('{ArrowUp}')
  expect(item('Withdraw player…')).toHaveFocus()
  await user.keyboard('{Home}')
  expect(item('Call to table')).toHaveFocus()
  await user.keyboard('{End}')
  expect(item('Withdraw player…')).toHaveFocus()

  await user.tab()
  expect(document.body).toHaveFocus()
})

test('choosing an item does what it says', async () => {
  const user = userEvent.setup()
  const onSelect = vi.fn()
  render(
    <Menu
      label="Match actions"
      items={[{ label: 'Print score sheet', onSelect }]}
    />,
  )

  await user.click(item('Print score sheet'))

  expect(onSelect).toHaveBeenCalledOnce()
})
