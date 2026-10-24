import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { SplitView } from './SplitView'

function renderSplit() {
  render(
    <SplitView
      label="Resize schedule and match details"
      start={<div>Schedule</div>}
      end={<div>Match details</div>}
    />,
  )
  return screen.getByRole('separator', { name: 'Resize schedule and match details' })
}

describe('SplitView', () => {
  it('starts with the schedule taking 58% of the width, between 35% and 72%', () => {
    const handle = renderSplit()

    expect(handle).toHaveAttribute('aria-valuenow', '58')
    expect(handle).toHaveAttribute('aria-valuemin', '35')
    expect(handle).toHaveAttribute('aria-valuemax', '72')
    expect(handle).toHaveAttribute('aria-orientation', 'vertical')
  })

  it('resizes by 4% with the arrow keys, and to the bounds with Home and End', async () => {
    const user = userEvent.setup()
    const handle = renderSplit()
    handle.focus()

    for (const [key, value] of [
      ['{ArrowRight}', '62'],
      ['{ArrowLeft}', '58'],
      ['{ArrowLeft}', '54'],
      ['{End}', '72'],
      ['{ArrowRight}', '72'],
      ['{Home}', '35'],
      ['{ArrowLeft}', '35'],
    ]) {
      await user.keyboard(key)
      expect(handle).toHaveAttribute('aria-valuenow', value)
    }
  })
})
