import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { Command, type CommandGroup } from './Command'

const groups: CommandGroup[] = [
  {
    heading: 'Suggestions',
    items: [
      {
        id: 'log',
        label: 'Log a match',
        shortcut: { label: '⌘ L', keys: 'Meta+L' },
      },
      { id: 'find', label: 'Find a player' },
    ],
  },
  { heading: 'Recent', items: [{ id: 'open', label: 'April Spring Open' }] },
]

function active() {
  const id = screen.getByRole('combobox').getAttribute('aria-activedescendant')
  return screen
    .getAllByRole('option')
    .filter((option) => option.getAttribute('aria-selected') === 'true')
    .map((option) => [option.id === id, option.textContent])
}

describe('Command', () => {
  it('is a combobox input over its listbox, both named', () => {
    render(
      <Command label="Command" placeholder="Type a command" groups={groups} />,
    )

    const combobox = screen.getByRole('combobox', { name: 'Command' })
    const listbox = screen.getByRole('listbox', { name: 'Command' })
    expect(combobox).toHaveAttribute('placeholder', 'Type a command')
    expect(combobox).toHaveAttribute('aria-expanded', 'true')
    expect(combobox).toHaveAttribute('aria-controls', listbox.id)
    expect(listbox).toHaveClass('cmd-list')
  })

  it('lists the commands in groups named by their headings', () => {
    render(<Command label="Command" groups={groups} />)

    expect(
      screen.getAllByRole('group').map((group) => [
        group.getAttribute('aria-labelledby') &&
          document.getElementById(group.getAttribute('aria-labelledby')!)
            ?.textContent,
        Array.from(
          group.querySelectorAll('[role="option"]'),
          (option) => option.textContent,
        ),
      ]),
    ).toEqual([
      ['Suggestions', ['Log a match⌘ L', 'Find a player']],
      ['Recent', ['April Spring Open']],
    ])
    expect(
      screen.getByRole('option', { name: 'Log a match' }),
    ).toHaveAttribute('aria-keyshortcuts', 'Meta+L')
  })

  it('starts on the first command, and the arrows move it, wrapping', async () => {
    const user = userEvent.setup()
    render(<Command label="Command" groups={groups} />)
    expect(active()).toEqual([[true, 'Log a match⌘ L']])

    await user.click(screen.getByRole('combobox'))
    await user.keyboard('{ArrowDown}')
    expect(active()).toEqual([[true, 'Find a player']])
    await user.keyboard('{ArrowDown}')
    expect(active()).toEqual([[true, 'April Spring Open']])
    await user.keyboard('{ArrowDown}')
    expect(active()).toEqual([[true, 'Log a match⌘ L']])
    await user.keyboard('{ArrowUp}')
    expect(active()).toEqual([[true, 'April Spring Open']])
    expect(screen.getByRole('combobox')).toHaveFocus()
  })

  it('makes the command under the pointer active', async () => {
    const user = userEvent.setup()
    render(<Command label="Command" groups={groups} />)

    await user.hover(screen.getByRole('option', { name: 'Find a player' }))

    expect(active()).toEqual([[true, 'Find a player']])
  })
})
