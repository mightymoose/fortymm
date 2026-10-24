import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InlineCalendar } from './InlineCalendar'
import { ToastProvider } from './ToastProvider'

describe('InlineCalendar', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('picks a day, keeps focus on it and announces it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const onChange = vi.fn()
    render(
      <ToastProvider>
        <InlineCalendar
          config={{ value: '2026-04-11', today: '2026-04-10', min: '2026-04-10' }}
          onChange={onChange}
        />
      </ToastProvider>,
    )
    const day = screen.getByRole('button', { name: 'Wednesday 15 April 2026' })

    await user.click(day)
    act(() => vi.advanceTimersByTime(40))

    expect(day).toHaveAttribute('aria-selected', 'true')
    expect(day).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Saturday 11 April 2026' })).toHaveAttribute(
      'aria-selected',
      'false',
    )
    expect(onChange).toHaveBeenCalledWith('2026-04-15')
    expect(screen.getByText('Wednesday 15 April 2026 selected')).toBeInTheDocument()
  })

  it('stays in the page on Esc', async () => {
    const user = userEvent.setup()
    render(
      <ToastProvider>
        <InlineCalendar config={{ today: '2026-04-10' }} />
      </ToastProvider>,
    )
    await user.click(screen.getByRole('button', { name: 'Friday 10 April 2026, today' }))

    await user.keyboard('{Escape}')

    expect(screen.getByRole('grid', { name: 'April 2026' })).toBeVisible()
  })
})
