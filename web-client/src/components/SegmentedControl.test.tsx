import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SegmentedControl } from './SegmentedControl'
import { ToastProvider } from './ToastProvider'

function renderControl() {
  const onChange = vi.fn()
  render(
    <ToastProvider>
      <button type="button">Before</button>
      <SegmentedControl
        label="Schedule view"
        options={['Timeline', 'List', 'By player']}
        onChange={onChange}
      />
      <button type="button">After</button>
    </ToastProvider>,
  )
  return onChange
}

const option = (name: string) => screen.getByRole('radio', { name })

describe('SegmentedControl', () => {
  it('starts with the first option on', () => {
    renderControl()

    expect(screen.getByRole('radiogroup', { name: 'Schedule view' })).toBeInTheDocument()
    expect(option('Timeline')).toBeChecked()
    expect(option('List')).not.toBeChecked()
    expect(option('By player')).not.toBeChecked()
  })

  it('turns on a clicked option and the others off', async () => {
    const user = userEvent.setup()
    const onChange = renderControl()

    await user.click(option('By player'))

    expect(option('By player')).toBeChecked()
    expect(option('Timeline')).not.toBeChecked()
    expect(onChange).toHaveBeenLastCalledWith('By player')
  })

  it('keeps an option on when it is clicked again', async () => {
    const user = userEvent.setup()
    renderControl()

    await user.click(option('Timeline'))

    expect(option('Timeline')).toBeChecked()
  })

  it('is one tab stop, on the option that is on', async () => {
    const user = userEvent.setup()
    renderControl()
    await user.click(option('List'))
    screen.getByRole('button', { name: 'Before' }).focus()

    await user.tab()
    expect(option('List')).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus()
  })

  it('moves with the arrow keys, Home and End, and wraps at the ends', async () => {
    const user = userEvent.setup()
    const onChange = renderControl()
    option('Timeline').focus()

    await user.keyboard('{ArrowLeft}')
    expect(option('By player')).toBeChecked()
    expect(option('By player')).toHaveFocus()
    expect(onChange).toHaveBeenLastCalledWith('By player')
    await user.keyboard('{ArrowRight}')
    expect(option('Timeline')).toBeChecked()
    await user.keyboard('{ArrowDown}')
    expect(option('List')).toBeChecked()
    await user.keyboard('{ArrowUp}')
    expect(option('Timeline')).toBeChecked()
    await user.keyboard('{End}')
    expect(option('By player')).toBeChecked()
    expect(option('By player')).toHaveFocus()
    await user.keyboard('{Home}')
    expect(option('Timeline')).toBeChecked()
    expect(option('Timeline')).toHaveFocus()
  })
})
