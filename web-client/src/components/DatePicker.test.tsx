import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { DatePicker } from './DatePicker'
import { Field, FieldHelp, Label } from './Field'
import { plainDate } from './plainDate'

const today = plainDate(2026, 4, 14)

function trigger(): HTMLElement {
  return screen.getByRole('button', { name: /^Match date/ })
}

function dialog(): HTMLElement | null {
  return screen.queryByRole('dialog')
}

// The day named `name`, e.g. "April 12, 2026".
function day(name: string): HTMLElement {
  return within(screen.getByRole('grid')).getByRole('gridcell', { name })
}

// The month the grid shows, which names it.
function month(): string {
  const id = screen.getByRole('grid').getAttribute('aria-labelledby')!
  return document.getElementById(id)!.textContent!
}

// The focused day's name. It must also be the one day in the tab order.
function focusedDay(): string | null {
  const inOrder = within(screen.getByRole('grid'))
    .getAllByRole('gridcell')
    .filter((cell) => cell.tabIndex === 0)
  expect(inOrder).toHaveLength(1)
  expect(inOrder[0]).toHaveFocus()
  return inOrder[0].getAttribute('aria-label')
}

// Opens a picker on `date` (chosen) and puts the focus in its grid.
async function openOn(year: number, monthNumber: number, date: number) {
  const user = userEvent.setup()
  render(
    <DatePicker
      aria-label="Match date"
      defaultValue={plainDate(year, monthNumber, date)}
      today={today}
    />,
  )
  await user.click(trigger())
  return user
}

describe('DatePicker', () => {
  it('renders a closed button showing the placeholder', () => {
    render(<DatePicker aria-label="Match date" today={today} />)

    const button = screen.getByRole('button', {
      name: 'Match date Pick a date',
    })
    expect(button).toHaveTextContent('Pick a date')
    expect(screen.getByText('Pick a date')).toHaveClass(
      'date-picker-placeholder',
    )
    expect(button).toHaveAttribute('aria-haspopup', 'dialog')
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(button).not.toHaveAttribute('aria-controls')
    expect(dialog()).toBeNull()
  })

  it('names the button with the chosen date', () => {
    render(
      <DatePicker
        aria-label="Match date"
        defaultValue={plainDate(2026, 4, 12)}
        today={today}
      />,
    )

    expect(
      screen.getByRole('button', { name: 'Match date April 12, 2026' }),
    ).toHaveTextContent('April 12, 2026')
    expect(screen.getByText('April 12, 2026')).not.toHaveClass(
      'date-picker-placeholder',
    )
  })

  it('opens on the chosen day, with the focus on it', async () => {
    await openOn(2026, 4, 12)

    expect(trigger()).toHaveAttribute('aria-expanded', 'true')
    expect(trigger()).toHaveAttribute('aria-controls', dialog()!.id)
    expect(screen.getByRole('dialog', { name: 'Match date' })).toBeVisible()
    expect(screen.getByRole('grid', { name: 'April 2026' })).toBeVisible()
    expect(focusedDay()).toBe('April 12, 2026')
  })

  it('shows the weeks of the month, with the days around it', async () => {
    await openOn(2026, 4, 12)

    const rows = within(screen.getByRole('grid')).getAllByRole('row')
    expect(
      within(rows[0])
        .getAllByRole('columnheader')
        .map((header) => [header.textContent, header.getAttribute('aria-label')]),
    ).toEqual([
      ['S', 'Sunday'],
      ['M', 'Monday'],
      ['T', 'Tuesday'],
      ['W', 'Wednesday'],
      ['T', 'Thursday'],
      ['F', 'Friday'],
      ['S', 'Saturday'],
    ])
    expect(
      rows.slice(1).map((row) =>
        within(row)
          .getAllByRole('gridcell')
          .map((cell) => cell.textContent),
      ),
    ).toEqual([
      ['29', '30', '31', '1', '2', '3', '4'],
      ['5', '6', '7', '8', '9', '10', '11'],
      ['12', '13', '14', '15', '16', '17', '18'],
      ['19', '20', '21', '22', '23', '24', '25'],
      ['26', '27', '28', '29', '30', '1', '2'],
    ])
    expect(day('March 31, 2026')).toHaveClass('day--muted')
    expect(day('May 1, 2026')).toHaveClass('day--muted')
    expect(day('April 1, 2026')).not.toHaveClass('day--muted')
  })

  it('opens on today with no day chosen', async () => {
    const user = userEvent.setup()
    render(<DatePicker aria-label="Match date" today={today} />)

    await user.click(trigger())

    expect(focusedDay()).toBe('April 14, 2026')
  })

  it('marks the chosen day selected and today current', async () => {
    await openOn(2026, 4, 12)

    const cells = within(screen.getByRole('grid')).getAllByRole('gridcell')
    expect(
      cells.filter((cell) => cell.getAttribute('aria-selected') === 'true'),
    ).toEqual([day('April 12, 2026')])
    expect(cells.filter((cell) => cell.hasAttribute('aria-current'))).toEqual([
      day('April 14, 2026'),
    ])
    expect(day('April 14, 2026')).toHaveAttribute('aria-current', 'date')
    expect(day('April 14, 2026')).toHaveAttribute('aria-selected', 'false')
  })

  it('closes on Escape, giving the focus back to the button', async () => {
    const user = await openOn(2026, 4, 12)

    await user.keyboard('{Escape}')

    expect(dialog()).toBeNull()
    expect(trigger()).toHaveFocus()
    expect(trigger()).toHaveAttribute('aria-expanded', 'false')
    expect(trigger()).toHaveAccessibleName('Match date April 12, 2026')
  })

  it('closes on Escape from the month buttons too', async () => {
    const user = await openOn(2026, 4, 12)

    await user.click(screen.getByRole('button', { name: 'Next month' }))
    await user.keyboard('{Escape}')

    expect(dialog()).toBeNull()
    expect(trigger()).toHaveFocus()
  })

  it('closes on a second click of the button', async () => {
    const user = await openOn(2026, 4, 12)

    await user.click(trigger())

    expect(dialog()).toBeNull()
    expect(trigger()).toHaveFocus()
  })

  // Safari doesn't focus a button on a press, so a press that let the focus
  // leave the open calendar would close it before the click reopened it.
  it("keeps the focus in the picker on a press of the button while it's open", async () => {
    await openOn(2026, 4, 12)

    expect(fireEvent.mouseDown(trigger())).toBe(false)
    expect(dialog()).toBeVisible()
    expect(focusedDay()).toBe('April 12, 2026')
  })

  it('closes on a click of its label, as on its button', async () => {
    const user = userEvent.setup()
    render(
      <Field>
        <DatePicker
          label={<Label>Match date</Label>}
          defaultValue={plainDate(2026, 4, 12)}
          today={today}
        />
      </Field>,
    )
    await user.click(trigger())
    await user.keyboard('{PageDown}')

    await user.click(screen.getByText('Match date'))

    expect(dialog()).toBeNull()
    expect(trigger()).toHaveFocus()
  })

  it('closes when the focus leaves it, but not on a click inside it', async () => {
    const user = userEvent.setup()
    render(
      <>
        <DatePicker
          aria-label="Match date"
          defaultValue={plainDate(2026, 4, 12)}
          today={today}
        />
        <button>Save</button>
      </>,
    )
    await user.click(trigger())

    await user.click(screen.getByText('April 2026'))
    expect(dialog()).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(dialog()).toBeNull()
  })

  it('tabs from the button to the month buttons and the focused day', async () => {
    const user = await openOn(2026, 4, 12)
    trigger().focus()

    await user.tab()
    expect(screen.getByRole('button', { name: 'Previous month' })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: 'Next month' })).toHaveFocus()
    await user.tab()
    expect(focusedDay()).toBe('April 12, 2026')
  })

  it('moves the focus a day with the left and right arrows', async () => {
    const user = await openOn(2026, 4, 12)

    await user.keyboard('{ArrowRight}')
    expect(focusedDay()).toBe('April 13, 2026')
    await user.keyboard('{ArrowLeft}{ArrowLeft}')
    expect(focusedDay()).toBe('April 11, 2026')
    // Moving the focus doesn't choose a day.
    expect(day('April 11, 2026')).toHaveAttribute('aria-selected', 'false')
    expect(day('April 12, 2026')).toHaveAttribute('aria-selected', 'true')
  })

  it('leaves the arrows with Alt, Ctrl or Meta to the browser', async () => {
    const user = await openOn(2026, 4, 12)

    await user.keyboard('{Alt>}{ArrowRight}{/Alt}{Control>}{ArrowLeft}{/Control}')
    await user.keyboard('{Meta>}{ArrowDown}{/Meta}')

    expect(focusedDay()).toBe('April 12, 2026')
  })

  it('moves the focus a week with the up and down arrows', async () => {
    const user = await openOn(2026, 4, 12)

    await user.keyboard('{ArrowDown}')
    expect(focusedDay()).toBe('April 19, 2026')
    await user.keyboard('{ArrowUp}{ArrowUp}')
    expect(focusedDay()).toBe('April 5, 2026')
  })

  it('moves the focus to the start and end of the week with Home and End', async () => {
    const user = await openOn(2026, 4, 15)

    await user.keyboard('{Home}')
    expect(focusedDay()).toBe('April 12, 2026')
    await user.keyboard('{End}')
    expect(focusedDay()).toBe('April 18, 2026')
  })

  it('moves the focus a month with PageUp and PageDown, and a year with Shift', async () => {
    const user = await openOn(2026, 4, 12)

    await user.keyboard('{PageDown}')
    expect(month()).toBe('May 2026')
    expect(focusedDay()).toBe('May 12, 2026')
    await user.keyboard('{PageUp}{PageUp}')
    expect(month()).toBe('March 2026')
    expect(focusedDay()).toBe('March 12, 2026')
    await user.keyboard('{Shift>}{PageDown}{/Shift}')
    expect(month()).toBe('March 2027')
    expect(focusedDay()).toBe('March 12, 2027')
    await user.keyboard('{Shift>}{PageUp}{PageUp}{/Shift}')
    expect(focusedDay()).toBe('March 12, 2025')
  })

  it('crosses into the next month and year with the arrows', async () => {
    const user = await openOn(2026, 1, 31)

    await user.keyboard('{ArrowRight}')
    expect(month()).toBe('February 2026')
    expect(focusedDay()).toBe('February 1, 2026')

    await user.keyboard('{Escape}')
    await user.click(trigger())
    await user.keyboard('{PageUp}{PageUp}{ArrowDown}{ArrowDown}{ArrowDown}')
    expect(month()).toBe('December 2025')
    expect(focusedDay()).toBe('December 21, 2025')
    await user.keyboard('{ArrowDown}{ArrowDown}')
    expect(month()).toBe('January 2026')
    expect(focusedDay()).toBe('January 4, 2026')
  })

  it('crosses into the month before with ArrowLeft and Home', async () => {
    const user = await openOn(2026, 4, 1)

    await user.keyboard('{ArrowLeft}')
    expect(month()).toBe('March 2026')
    expect(focusedDay()).toBe('March 31, 2026')

    await user.keyboard('{ArrowRight}{Home}')
    expect(month()).toBe('March 2026')
    expect(focusedDay()).toBe('March 29, 2026')
  })

  it('goes from December 31 to January 1 of the next year', async () => {
    const user = await openOn(2026, 12, 31)

    await user.keyboard('{ArrowRight}')

    expect(month()).toBe('January 2027')
    expect(focusedDay()).toBe('January 1, 2027')
  })

  it('goes from December to January with PageDown', async () => {
    const user = await openOn(2026, 12, 15)

    await user.keyboard('{PageDown}')

    expect(month()).toBe('January 2027')
    expect(focusedDay()).toBe('January 15, 2027')
  })

  it("keeps PageDown in the next month when it's shorter", async () => {
    const user = await openOn(2026, 1, 31)

    await user.keyboard('{PageDown}')
    expect(focusedDay()).toBe('February 28, 2026')

    await user.keyboard('{Escape}')
    await user.click(trigger())
    await user.keyboard('{Shift>}{PageUp}{PageUp}{/Shift}{PageDown}')
    expect(focusedDay()).toBe('February 29, 2024')
  })

  it('chooses the focused day with Enter', async () => {
    const onValueChange = vi.fn()
    const user = userEvent.setup()
    render(
      <DatePicker
        aria-label="Match date"
        defaultValue={plainDate(2026, 4, 12)}
        today={today}
        onValueChange={onValueChange}
      />,
    )
    await user.click(trigger())

    await user.keyboard('{ArrowRight}{ArrowRight}{Enter}')

    expect(onValueChange).toHaveBeenCalledExactlyOnceWith('2026-04-14')
    expect(dialog()).toBeNull()
    expect(trigger()).toHaveFocus()
    expect(trigger()).toHaveAccessibleName('Match date April 14, 2026')
    expect(trigger()).toHaveTextContent('April 14, 2026')

    await user.click(trigger())
    expect(focusedDay()).toBe('April 14, 2026')
    expect(day('April 14, 2026')).toHaveAttribute('aria-selected', 'true')
    expect(day('April 14, 2026')).toHaveAttribute('aria-current', 'date')
    expect(day('April 12, 2026')).toHaveAttribute('aria-selected', 'false')
  })

  it('chooses the focused day with Space', async () => {
    const user = await openOn(2026, 4, 12)

    await user.keyboard('{ArrowDown} ')

    expect(dialog()).toBeNull()
    expect(trigger()).toHaveFocus()
    expect(trigger()).toHaveAccessibleName('Match date April 19, 2026')
  })

  it('chooses a day on a click, from the month around it too', async () => {
    const user = await openOn(2026, 4, 12)

    await user.click(day('April 20, 2026'))
    expect(dialog()).toBeNull()
    expect(trigger()).toHaveFocus()
    expect(trigger()).toHaveAccessibleName('Match date April 20, 2026')

    await user.click(trigger())
    await user.click(day('May 2, 2026'))
    expect(trigger()).toHaveAccessibleName('Match date May 2, 2026')
    await user.click(trigger())
    expect(month()).toBe('May 2026')
  })

  it('changes the month with its buttons, keeping the focus on them', async () => {
    const user = await openOn(2026, 1, 31)
    const previous = screen.getByRole('button', { name: 'Previous month' })
    const next = screen.getByRole('button', { name: 'Next month' })

    await user.click(next)
    expect(month()).toBe('February 2026')
    expect(next).toHaveFocus()
    await user.click(previous)
    await user.click(previous)
    expect(month()).toBe('December 2025')
    expect(previous).toHaveFocus()

    await user.tab()
    await user.tab()
    expect(focusedDay()).toBe('December 28, 2025')
  })

  it("starts open without taking the focus, if it's told to", () => {
    render(
      <DatePicker
        aria-label="Match date"
        defaultValue={plainDate(2026, 4, 12)}
        defaultOpen
        today={today}
      />,
    )

    expect(screen.getByRole('grid', { name: 'April 2026' })).toBeVisible()
    expect(trigger()).toHaveAttribute('aria-expanded', 'true')
    expect(day('April 12, 2026')).toHaveAttribute('tabindex', '0')
    expect(document.body).toHaveFocus()
  })

  it("doesn't open when disabled", async () => {
    const user = userEvent.setup()
    render(
      <DatePicker
        aria-label="Match date"
        defaultValue={plainDate(2026, 4, 12)}
        defaultOpen
        today={today}
        disabled
      />,
    )

    expect(trigger()).toBeDisabled()
    expect(trigger()).toHaveAttribute('aria-expanded', 'false')
    expect(dialog()).toBeNull()

    await user.click(trigger())
    expect(dialog()).toBeNull()
  })

  it('stays closed once it is enabled again', async () => {
    const user = userEvent.setup()
    const { rerender } = render(
      <DatePicker aria-label="Match date" today={today} />,
    )
    await user.click(trigger())
    expect(dialog()).toBeVisible()

    rerender(<DatePicker aria-label="Match date" today={today} disabled />)
    expect(dialog()).toBeNull()
    rerender(<DatePicker aria-label="Match date" today={today} />)

    expect(dialog()).toBeNull()
    expect(trigger()).toHaveAttribute('aria-expanded', 'false')
  })

  it('adds its className to the date-picker class on its root', () => {
    render(
      <DatePicker
        aria-label="Match date"
        today={today}
        className="date-picker-demo"
      />,
    )

    expect(trigger().closest('.date-picker')).toHaveAttribute(
      'class',
      'date-picker date-picker-demo',
    )
    expect(trigger()).toHaveAttribute(
      'class',
      'button button--outline date-picker-trigger',
    )
  })

  it("takes a Field's label, help text and invalid state", async () => {
    const user = userEvent.setup()
    render(
      <Field invalid>
        <DatePicker
          label={<Label>Match date</Label>}
          defaultValue={plainDate(2026, 4, 12)}
          today={today}
        />
        <FieldHelp>Pick a day after the draw.</FieldHelp>
      </Field>,
    )

    const button = screen.getByRole('button', {
      name: 'Match date April 12, 2026',
    })
    expect(button).toHaveAccessibleDescription('Pick a day after the draw.')
    expect(button).toHaveAttribute('data-invalid')
    expect(button).not.toHaveAttribute('aria-invalid')
    expect(screen.getByText('Match date')).toHaveAttribute('for', button.id)

    await user.click(button)
    expect(screen.getByRole('dialog', { name: 'Match date' })).toBeVisible()
  })

  it('shows a required Field by its label only', () => {
    render(
      <Field required>
        <DatePicker label={<Label>Match date</Label>} today={today} />
      </Field>,
    )

    const button = screen.getByRole('button', { name: /^Match date/ })
    expect(button).not.toHaveAttribute('required')
    expect(button).not.toHaveAttribute('aria-required')
    expect(screen.getByText('*')).toHaveAttribute('aria-hidden', 'true')
  })

  it("isn't invalid outside an invalid Field, or with aria-invalid false", () => {
    render(
      <>
        <Field>
          <DatePicker label={<Label>Match date</Label>} today={today} />
        </Field>
        <DatePicker aria-label="Match date" aria-invalid="false" today={today} />
      </>,
    )

    for (const button of screen.getAllByRole('button', { name: /^Match date/ })) {
      expect(button).not.toHaveAttribute('data-invalid')
    }
  })

  it("is disabled by a disabled Field", () => {
    render(
      <Field disabled>
        <DatePicker
          label={<Label>Match date</Label>}
          today={today}
          defaultOpen
        />
      </Field>,
    )

    expect(trigger()).toBeDisabled()
    expect(dialog()).toBeNull()
  })

  describe('with no today given', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it("marks today's date on the user's clock", async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(2026, 3, 14, 12))
      const user = userEvent.setup()
      render(<DatePicker aria-label="Match date" />)

      await user.click(trigger())

      expect(focusedDay()).toBe('April 14, 2026')
      expect(day('April 14, 2026')).toHaveAttribute('aria-current', 'date')
    })
  })

  // A day is a calendar date, with no time zone, so it mustn't shift where
  // local midnight isn't UTC midnight or a day isn't 24 hours long.
  describe('in a time zone with daylight saving time', () => {
    beforeAll(() => {
      vi.stubEnv('TZ', 'America/New_York')
    })

    afterAll(() => {
      vi.unstubAllEnvs()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('runs west of UTC, with a 25-hour day on November 1, 2026', () => {
      expect(new Date(2026, 3, 14).getTimezoneOffset()).toBe(240)
      expect(
        new Date(2026, 10, 2).getTime() - new Date(2026, 10, 1).getTime(),
      ).toBe(25 * 60 * 60 * 1000)
    })

    it('moves the focus across the change of the clocks a day at a time', async () => {
      const user = await openOn(2026, 10, 31)

      await user.keyboard('{ArrowRight}')
      expect(focusedDay()).toBe('November 1, 2026')
      await user.keyboard('{ArrowRight}')
      expect(focusedDay()).toBe('November 2, 2026')
      await user.keyboard('{ArrowLeft}{ArrowLeft}')
      expect(focusedDay()).toBe('October 31, 2026')
    })

    it('shows the chosen date as it was given', () => {
      render(
        <DatePicker
          aria-label="Match date"
          defaultValue={plainDate(2026, 4, 12)}
          today={today}
        />,
      )

      expect(trigger()).toHaveAccessibleName('Match date April 12, 2026')
    })

    it("takes today's date late in the evening from local time, not UTC", async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(2026, 3, 14, 23, 30))
      const user = userEvent.setup()
      render(<DatePicker aria-label="Match date" />)

      await user.click(trigger())

      expect(day('April 14, 2026')).toHaveAttribute('aria-current', 'date')
      expect(focusedDay()).toBe('April 14, 2026')
    })
  })
})
