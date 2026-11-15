import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { RatedField } from './RatedField.tsx'

// RatedField alone, after fortymm-real's rated-field.test.tsx.
function rated() {
  return screen.getByRole('switch', { name: 'Rated match' })
}

test('with no opponent, it is off and disabled, says why, and shows “No opponent · unavailable”', () => {
  render(<RatedField rated={false} ratable={false} onChange={vi.fn()} />)

  expect(rated()).toBeDisabled()
  expect(rated()).not.toBeChecked()
  expect(rated()).toHaveAccessibleDescription(
    'Enter your opponent’s name to make this rated.',
  )
  expect(screen.getByText('No opponent · unavailable')).toBeVisible()
})

test('with no opponent, a stored on still shows off', () => {
  render(<RatedField rated ratable={false} onChange={vi.fn()} />)

  expect(rated()).not.toBeChecked()
})

test('with an opponent and off, it is enabled: just for fun, no rating change', () => {
  render(<RatedField rated={false} ratable onChange={vi.fn()} />)

  expect(rated()).toBeEnabled()
  expect(rated()).toHaveTextContent('Just for fun')
  expect(rated()).toHaveAccessibleDescription(
    'No rating change. Still logged to history.',
  )
  expect(screen.queryByText('No opponent · unavailable')).toBeNull()
})

test('on, it counts toward rating and updates both', () => {
  render(<RatedField rated ratable onChange={vi.fn()} />)

  expect(rated()).toBeChecked()
  expect(rated()).toHaveTextContent('Counts toward rating')
  expect(rated()).toHaveAccessibleDescription(
    'Result will update both ratings.',
  )
})

test('pressing it asks to turn it on', async () => {
  const onChange = vi.fn()
  render(<RatedField rated={false} ratable onChange={onChange} />)

  await userEvent.click(rated())

  expect(onChange).toHaveBeenCalledWith(true)
})

test('disabled, pressing it asks nothing', async () => {
  const onChange = vi.fn()
  render(<RatedField rated={false} ratable={false} onChange={onChange} />)

  await userEvent.click(rated())

  expect(onChange).not.toHaveBeenCalled()
})
