import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { SegmentedControl } from './SegmentedControl.tsx'

function renderViews(onChange?: (value: string) => void) {
  render(
    <SegmentedControl
      label="View"
      defaultValue="list"
      onChange={onChange}
      options={[
        { value: 'list', label: 'List' },
        { value: 'timeline', label: 'Timeline' },
        { value: 'tables', label: 'Tables' },
      ]}
    />,
  )
}

const option = (name: string) => screen.getByRole('radio', { name })

test('choosing an option turns it on and the one that was on off, and tells the listener', async () => {
  const user = userEvent.setup()
  const onChange = vi.fn()
  renderViews(onChange)

  await user.click(option('Timeline'))

  expect(screen.getByRole('radiogroup', { name: 'View' })).toBeVisible()
  expect(option('Timeline')).toBeChecked()
  expect(option('List')).not.toBeChecked()
  expect(onChange).toHaveBeenCalledExactlyOnceWith('timeline')
})

test('choosing the option that is on keeps it on: one is always on', async () => {
  const user = userEvent.setup()
  const onChange = vi.fn()
  renderViews(onChange)

  await user.click(option('List'))

  expect(option('List')).toBeChecked()
  expect(onChange).not.toHaveBeenCalled()
})

test('the arrow keys move to the next option and turn it on', async () => {
  const user = userEvent.setup()
  renderViews()
  await user.tab()
  expect(option('List')).toHaveFocus()

  await user.keyboard('{ArrowRight}')

  expect(option('Timeline')).toHaveFocus()
  expect(option('Timeline')).toBeChecked()
})
