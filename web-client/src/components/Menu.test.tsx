import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Menu } from './Menu'

describe('Menu', () => {
  it('is a menu named by its label, its commands in order with their shortcuts', () => {
    render(
      <Menu
        label="Match actions"
        items={[
          { label: 'Edit match' },
          { label: 'Print score sheet', shortcut: '⌘P' },
          'divider',
          { label: 'Remove from schedule', danger: true },
        ]}
      />,
    )

    const menu = screen.getByRole('menu', { name: 'Match actions' })
    expect(menu).toBeVisible()
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Edit match',
      'Print score sheet⌘P',
      'Remove from schedule',
    ])
    expect(screen.getByText('⌘P').tagName).toBe('SMALL')
  })

  it('puts a divider before the destructive command, and marks it in red', () => {
    render(
      <Menu
        label="Match actions"
        items={[{ label: 'Edit match' }, 'divider', { label: 'Remove', danger: true }]}
      />,
    )

    const remove = screen.getByRole('menuitem', { name: 'Remove' })
    expect(remove).toHaveClass('fm-menu__item--danger')
    expect(screen.getByRole('menuitem', { name: 'Edit match' })).not.toHaveClass(
      'fm-menu__item--danger',
    )
    expect(remove.previousElementSibling).toBe(screen.getByRole('separator'))
  })

  it('gives each command the behaviour it is passed', async () => {
    const user = userEvent.setup()
    const onEdit = vi.fn()
    render(
      <Menu
        label="Match actions"
        items={[{ label: 'Edit match' }]}
        commandProps={(command) => ({ onClick: () => onEdit(command.label) })}
      />,
    )

    await user.click(screen.getByRole('menuitem', { name: 'Edit match' }))

    expect(onEdit).toHaveBeenCalledWith('Edit match')
  })
})
