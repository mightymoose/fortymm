import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Select } from './Select.tsx'

const events = ['Open singles', 'Under 18 singles', 'Open doubles']

describe('Select', () => {
  it('is named by its label', () => {
    render(<Select label="Event" options={events} />)
    expect(screen.getByRole('combobox', { name: 'Event' })).toBeInTheDocument()
  })

  it('lists its options', () => {
    render(<Select label="Event" options={events} />)
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(events)
  })

  it('selects its default value', () => {
    render(<Select label="Event" options={events} defaultValue="Open doubles" />)
    expect(screen.getByRole('combobox', { name: 'Event' })).toHaveValue('Open doubles')
  })
})
