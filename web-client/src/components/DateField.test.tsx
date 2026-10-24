import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { DateField } from './DateField'
import { ToastProvider } from './ToastProvider'

function renderField() {
  const onChange = vi.fn()
  render(
    <ToastProvider>
      <DateField
        label="Tournament date"
        help="Players see this on the entry page."
        config={{ value: '2026-04-11', today: '2026-04-10', min: '2026-04-10' }}
        onChange={onChange}
      />
    </ToastProvider>,
  )
  return { onChange }
}

const field = () => screen.getByRole('textbox', { name: 'Tournament date' })
const calendarButton = () => screen.getByRole('button', { name: 'Open calendar' })
const calendar = () => screen.getByRole('dialog', { name: 'Choose date' })
const day = (name: string) => screen.getByRole('button', { name })

describe('DateField', () => {
  it('shows its date in full', () => {
    renderField()

    expect(field()).toHaveValue('Saturday 11 April 2026')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('reads a typed date on Enter and shows it in full', async () => {
    const user = userEvent.setup()
    const { onChange } = renderField()

    await user.clear(field())
    await user.type(field(), 'Sat 25 Apr{Enter}')

    expect(field()).toHaveValue('Saturday 25 April 2026')
    expect(onChange).toHaveBeenCalledWith('2026-04-25')
  })

  it('reads a typed date when it loses focus', async () => {
    const user = userEvent.setup()
    renderField()

    await user.clear(field())
    await user.type(field(), '20/4/2026')
    await user.tab()

    expect(field()).toHaveValue('Monday 20 April 2026')
  })

  it('says how to write a date it can’t read', async () => {
    const user = userEvent.setup()
    renderField()

    await user.clear(field())
    await user.type(field(), 'soon{Enter}')

    expect(field()).toHaveAttribute('aria-invalid', 'true')
    expect(field()).toHaveAccessibleDescription(
      'Players see this on the entry page. Enter a date like 11 April 2026 or 11/4/2026.',
    )
  })

  it('refuses a date before the first it allows', async () => {
    const user = userEvent.setup()
    renderField()

    await user.clear(field())
    await user.type(field(), '9 April{Enter}')

    expect(field()).toHaveAccessibleDescription(
      'Players see this on the entry page. Pick Friday 10 April 2026 or later.',
    )
  })

  it('opens the calendar on the field’s date, with today outlined and past days off', async () => {
    const user = userEvent.setup()
    renderField()

    await user.click(calendarButton())

    expect(calendar()).toBeVisible()
    expect(calendarButton()).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('grid', { name: 'April 2026' })).toBeVisible()
    expect(day('Saturday 11 April 2026')).toHaveFocus()
    expect(day('Saturday 11 April 2026')).toHaveAttribute('aria-selected', 'true')
    expect(day('Friday 10 April 2026, today')).toHaveClass('today')
    expect(day('Thursday 9 April 2026')).toBeDisabled()
  })

  it('moves by day, week and month with the keys, and Today goes back', async () => {
    const user = userEvent.setup()
    renderField()
    await user.click(field())

    await user.keyboard('{Alt>}{ArrowDown}{/Alt}')
    expect(day('Saturday 11 April 2026')).toHaveFocus()
    await user.keyboard('{ArrowRight}{ArrowDown}')
    expect(day('Sunday 19 April 2026')).toHaveFocus()
    await user.keyboard('{PageDown}')
    expect(day('Tuesday 19 May 2026')).toHaveFocus()
    expect(screen.getByRole('grid', { name: 'May 2026' })).toBeVisible()
    await user.keyboard('{Home}')
    expect(day('Monday 18 May 2026')).toHaveFocus()
    await user.keyboard('{End}{ArrowLeft}{ArrowUp}')
    expect(day('Saturday 16 May 2026')).toHaveFocus()

    await user.click(screen.getByRole('button', { name: 'Today' }))
    expect(day('Friday 10 April 2026, today')).toHaveFocus()
  })

  it('shows the next and previous months', async () => {
    const user = userEvent.setup()
    renderField()
    await user.click(calendarButton())

    await user.click(screen.getByRole('button', { name: 'Next month' }))
    expect(screen.getByRole('grid', { name: 'May 2026' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Previous month' }))
    await user.click(screen.getByRole('button', { name: 'Previous month' }))
    expect(screen.getByRole('grid', { name: 'March 2026' })).toBeVisible()
  })

  it('fills the field with a picked day, closes and returns focus', async () => {
    const user = userEvent.setup()
    const { onChange } = renderField()
    await user.click(calendarButton())

    await user.keyboard('{ArrowDown}{Enter}')

    expect(field()).toHaveValue('Saturday 18 April 2026')
    expect(onChange).toHaveBeenCalledWith('2026-04-18')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(calendarButton()).toHaveFocus()
  })

  it('closes on Esc and returns focus to its button', async () => {
    const user = userEvent.setup()
    renderField()
    await user.click(calendarButton())

    await user.keyboard('{Escape}')

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(calendarButton()).toHaveFocus()
  })

  it('closes on a click outside', async () => {
    const user = userEvent.setup()
    renderField()
    await user.click(calendarButton())

    await user.click(document.body)

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
