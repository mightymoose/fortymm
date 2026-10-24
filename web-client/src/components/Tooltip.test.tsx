import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Tooltip } from './Tooltip'

describe('Tooltip', () => {
  it('describes its trigger', () => {
    render(
      <Tooltip text="Refresh standings">
        {(tooltipId) => (
          <button type="button" aria-describedby={tooltipId}>
            Refresh
          </button>
        )}
      </Tooltip>,
    )

    const tooltip = screen.getByRole('tooltip')
    expect(tooltip).toHaveTextContent('Refresh standings')
    expect(tooltip).toHaveClass('tooltip-bubble')
    expect(
      screen.getByRole('button', {
        name: 'Refresh',
        description: 'Refresh standings',
      }),
    ).toBeInTheDocument()
  })

  it('holds the trigger, then the bubble', () => {
    render(
      <Tooltip text="Tip">{() => <span>Trigger</span>}</Tooltip>,
    )

    const trigger = screen.getByText('Trigger')
    expect(trigger.parentElement).toHaveClass('tooltip')
    expect(trigger.nextElementSibling).toBe(screen.getByRole('tooltip'))
  })
})
