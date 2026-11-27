import { render, screen } from '@testing-library/react'
import { describe, expect } from 'vitest'
import { it } from '../setupTests.ts'
import { ComboBox } from './ComboBox.tsx'
import { type ComboBoxItem } from './ComboBoxItem.ts'

const players: ComboBoxItem[] = [
  { id: 'thanh', name: 'Nguyen, Thanh', description: 'Riverside TT', meta: '2,145' },
  { id: 'linh', name: 'Nguyen, Linh', description: 'Eastgate', meta: '1,702' },
  { id: 'park', name: 'Park, Ji-ho', description: 'Riverside TT', meta: '1,980' },
]

describe('ComboBox', () => {
  it('is a combobox named by its label', () => {
    render(<ComboBox label="Opponent" items={players} />)
    expect(screen.getByRole('combobox', { name: 'Opponent' })).toBeInTheDocument()
  })

  it('is described by its help', () => {
    render(<ComboBox label="Opponent" items={players} description="Only checked-in players." />)
    expect(screen.getByRole('combobox', { name: 'Opponent' })).toHaveAccessibleDescription(
      'Only checked-in players.',
    )
  })

  it('starts closed', () => {
    render(<ComboBox label="Opponent" items={players} />)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('lists the players that match what is typed', async ({ user }) => {
    render(<ComboBox label="Opponent" items={players} />)
    await user.type(screen.getByRole('combobox', { name: 'Opponent' }), 'ngu')
    expect(screen.getAllByRole('option').map((option) => option.querySelector('b')?.textContent)).toEqual([
      'Nguyen, Thanh',
      'Nguyen, Linh',
    ])
  })

  it('ignores accents when matching', async ({ user }) => {
    render(<ComboBox label="Opponent" items={players} />)
    await user.type(screen.getByRole('combobox', { name: 'Opponent' }), 'ngùy')
    expect(screen.getAllByRole('option')).toHaveLength(2)
  })

  it('bolds the part of a name that matches', async ({ user }) => {
    render(<ComboBox label="Opponent" items={players} />)
    await user.type(screen.getByRole('combobox', { name: 'Opponent' }), 'ji')
    expect(screen.getByRole('option').querySelector('mark')).toHaveTextContent('Ji')
  })

  it('fills in the player picked', async ({ user }) => {
    render(<ComboBox label="Opponent" items={players} />)
    await user.type(screen.getByRole('combobox', { name: 'Opponent' }), 'park')
    await user.click(screen.getByRole('option'))
    expect(screen.getByRole('combobox', { name: 'Opponent' })).toHaveValue('Park, Ji-ho')
  })

  it('highlights the option the arrow keys move to', async ({ user }) => {
    render(<ComboBox label="Opponent" items={players} />)
    await user.type(screen.getByRole('combobox', { name: 'Opponent' }), 'ngu')
    await user.keyboard('{ArrowDown}')
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true')
  })
})
