import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useTooltip } from './tooltipContext'
import { TOOLTIP_DELAY_MS, TooltipProvider } from './TooltipProvider'

function PrintButton() {
  const tip = useTooltip('Print score sheet')
  return (
    <button type="button" aria-label="Print" {...tip}>
      P
    </button>
  )
}

function renderTooltip() {
  render(
    <TooltipProvider>
      <PrintButton />
    </TooltipProvider>,
  )
  return screen.getByRole('button', { name: 'Print' })
}

describe('TooltipProvider', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows the tooltip once the pointer rests on its trigger', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const trigger = renderTooltip()

    await user.hover(trigger)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    act(() => vi.advanceTimersByTime(TOOLTIP_DELAY_MS))

    expect(screen.getByRole('tooltip')).toHaveTextContent('Print score sheet')
    expect(trigger).toHaveAccessibleDescription('Print score sheet')
  })

  it('hides the tooltip when the pointer leaves', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const trigger = renderTooltip()
    await user.hover(trigger)
    act(() => vi.advanceTimersByTime(TOOLTIP_DELAY_MS))

    await user.unhover(trigger)

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    expect(trigger).not.toHaveAccessibleDescription()
  })

  it('shows the tooltip on keyboard focus, and Esc hides it', async () => {
    const user = userEvent.setup()
    const trigger = renderTooltip()

    await user.tab()

    expect(trigger).toHaveFocus()
    expect(screen.getByRole('tooltip')).toHaveTextContent('Print score sheet')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('hides the tooltip when its trigger loses focus', async () => {
    const user = userEvent.setup()
    renderTooltip()
    await user.tab()

    await user.tab()

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('shows no tooltip for a touch', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const trigger = renderTooltip()

    await user.pointer({ keys: '[TouchA]', target: trigger })
    act(() => vi.advanceTimersByTime(TOOLTIP_DELAY_MS))

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })
})
