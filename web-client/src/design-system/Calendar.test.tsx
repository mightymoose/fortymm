import { CalendarDate } from '@internationalized/date'
import { render, screen } from '@testing-library/react'
import { I18nProvider } from 'react-aria'
import { describe, expect, vi } from 'vitest'
import { it } from '../setupTests.ts'
import { Calendar } from './Calendar.tsx'

const today = new CalendarDate(2026, 4, 10)
const april11 = new CalendarDate(2026, 4, 11)

function dayButton(day: string) {
  return screen.getAllByRole('button', { name: new RegExp(`\\b${day}\\b`) })[0]
}

describe('Calendar', () => {
  it('shows the month of its value', () => {
    render(<Calendar defaultValue={april11} today={today} />)
    expect(screen.getByText('April 2026')).toBeInTheDocument()
  })

  it('starts its weeks on Sunday in the US', () => {
    render(<Calendar defaultValue={april11} today={today} />)
    expect(screen.getAllByRole('columnheader')[0]).toHaveAttribute('abbr', 'Sunday')
  })

  it('starts its weeks on Monday in Britain', () => {
    render(
      <I18nProvider locale="en-GB">
        <Calendar defaultValue={april11} today={today} />
      </I18nProvider>,
    )
    expect(screen.getAllByRole('columnheader')[0]).toHaveAttribute('abbr', 'Monday')
  })

  it('marks today', () => {
    render(<Calendar defaultValue={april11} today={today} />)
    expect(screen.getByRole('button', { current: 'date' })).toHaveTextContent('10')
  })

  it('marks the selected day', () => {
    render(<Calendar defaultValue={april11} today={today} />)
    expect(dayButton('April 11')).toHaveAttribute('aria-selected', 'true')
  })

  it('disables days before its minimum', () => {
    render(<Calendar defaultValue={april11} today={today} minValue={today} />)
    expect(dayButton('April 9')).toBeDisabled()
  })

  it('picks the day clicked', async ({ user }) => {
    const onChange = vi.fn()
    render(<Calendar defaultValue={april11} today={today} onChange={onChange} />)
    await user.click(dayButton('April 15'))
    expect(onChange).toHaveBeenCalledWith(new CalendarDate(2026, 4, 15))
  })

  it('turns to the next month', async ({ user }) => {
    render(<Calendar defaultValue={april11} today={today} />)
    await user.click(screen.getByRole('button', { name: 'Next month' }))
    expect(screen.getByRole('grid')).toHaveAccessibleName('May 2026')
  })

  it('says which day is today', () => {
    render(<Calendar defaultValue={april11} today={today} />)
    expect(screen.getByText('Today: Friday, April 10')).toBeInTheDocument()
  })
})
