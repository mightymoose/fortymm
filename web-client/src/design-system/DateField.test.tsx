import { CalendarDate } from '@internationalized/date'
import { render, screen } from '@testing-library/react'
import { describe, expect, vi } from 'vitest'
import { it } from '../setupTests.ts'
import { DateField } from './DateField.tsx'

const today = new CalendarDate(2026, 4, 10)
const april11 = new CalendarDate(2026, 4, 11)

function field() {
  return screen.getByRole('textbox', { name: 'Tournament date' })
}

describe('DateField', () => {
  it('writes its date out in full', () => {
    render(<DateField label="Tournament date" defaultValue={april11} today={today} />)
    expect(field()).toHaveValue('Saturday, April 11, 2026')
  })

  it('reads a typed date when it loses focus', async ({ user }) => {
    const onChange = vi.fn()
    render(<DateField label="Tournament date" today={today} onChange={onChange} />)
    await user.type(field(), '4/18/2026')
    await user.tab()
    expect(onChange).toHaveBeenCalledWith(new CalendarDate(2026, 4, 18))
  })

  it('writes a typed date out in full', async ({ user }) => {
    render(<DateField label="Tournament date" today={today} />)
    await user.type(field(), '4/18/2026')
    await user.tab()
    expect(field()).toHaveValue('Saturday, April 18, 2026')
  })

  it('says so when it cannot read the date', async ({ user }) => {
    render(<DateField label="Tournament date" today={today} />)
    await user.type(field(), 'soon')
    await user.tab()
    expect(field()).toHaveAccessibleDescription('Enter a date like Friday, April 10, 2026.')
  })

  it('says so when the date is too early', async ({ user }) => {
    render(<DateField label="Tournament date" today={today} minValue={today} />)
    await user.type(field(), '4/9/2026')
    await user.tab()
    expect(field()).toHaveAccessibleDescription('Choose Friday, April 10, 2026 or later.')
  })

  it('opens a calendar from its button', async ({ user }) => {
    render(<DateField label="Tournament date" defaultValue={april11} today={today} />)
    await user.click(screen.getByRole('button', { name: 'Open calendar' }))
    expect(screen.getByRole('grid')).toBeInTheDocument()
  })

  it('takes the day picked from the calendar', async ({ user }) => {
    render(<DateField label="Tournament date" defaultValue={april11} today={today} />)
    await user.click(screen.getByRole('button', { name: 'Open calendar' }))
    await user.click(screen.getAllByRole('button', { name: /\bApril 15\b/ })[0])
    expect(field()).toHaveValue('Wednesday, April 15, 2026')
  })

  it('closes the calendar after a day is picked', async ({ user }) => {
    render(<DateField label="Tournament date" defaultValue={april11} today={today} />)
    await user.click(screen.getByRole('button', { name: 'Open calendar' }))
    await user.click(screen.getAllByRole('button', { name: /\bApril 15\b/ })[0])
    expect(screen.queryByRole('grid')).not.toBeInTheDocument()
  })

  it('closes the calendar on Escape', async ({ user }) => {
    render(<DateField label="Tournament date" defaultValue={april11} today={today} />)
    await user.click(screen.getByRole('button', { name: 'Open calendar' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('grid')).not.toBeInTheDocument()
  })
})
