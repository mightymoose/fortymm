import { render, screen } from '@testing-library/react'
import { describe, expect } from 'vitest'
import { it } from '../setupTests.ts'
import { SplitView } from './SplitView.tsx'

function renderSplitView() {
  render(
    <SplitView
      label="Resize schedule and match details"
      defaultValue={66}
      minValue={35}
      maxValue={72}
      start="Schedule"
      end="Match details"
    />,
  )
  return screen.getByRole('separator', { name: 'Resize schedule and match details' })
}

describe('SplitView', () => {
  it('has a separator at its default value', () => {
    expect(renderSplitView()).toHaveAttribute('aria-valuenow', '66')
  })

  it('moves the separator left with the arrow key', async ({ user }) => {
    const separator = renderSplitView()
    separator.focus()
    await user.keyboard('{ArrowLeft}')
    expect(separator).toHaveAttribute('aria-valuenow', '64')
  })

  it('moves the separator right with the arrow key', async ({ user }) => {
    const separator = renderSplitView()
    separator.focus()
    await user.keyboard('{ArrowRight}')
    expect(separator).toHaveAttribute('aria-valuenow', '68')
  })

  it('stops the separator at its maximum', async ({ user }) => {
    const separator = renderSplitView()
    separator.focus()
    await user.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}')
    expect(separator).toHaveAttribute('aria-valuenow', '72')
  })
})
