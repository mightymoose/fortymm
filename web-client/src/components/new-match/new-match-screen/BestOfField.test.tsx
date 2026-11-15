import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { BestOfField } from './BestOfField.tsx'

// BestOfField alone, after fortymm-real's best-of-field.test.tsx.
function option(n: number) {
  return screen.getByRole('radio', { name: `Best of ${n}` })
}

test('a radiogroup named Match length, best of 1, 3, 5 and 7, the current one checked', () => {
  render(<BestOfField bestOf={3} onChange={vi.fn()} />)

  const group = screen.getByRole('radiogroup', { name: 'Match length' })
  expect(group).toBeVisible()
  expect(option(3)).toBeChecked()
  expect(option(5)).not.toBeChecked()
  expect(screen.getAllByRole('radio')).toHaveLength(4)
})

test('says what the length means: one game, or first to more than half', () => {
  const { unmount } = render(<BestOfField bestOf={1} onChange={vi.fn()} />)
  expect(
    screen.getByText('One game, winner takes all. Games to 11, win by 2.'),
  ).toBeVisible()
  unmount()

  render(<BestOfField bestOf={7} onChange={vi.fn()} />)
  expect(
    screen.getByText('First to 4 games. Games to 11, win by 2.'),
  ).toBeVisible()
})

test('pressing a length chooses it', async () => {
  const onChange = vi.fn()
  render(<BestOfField bestOf={5} onChange={onChange} />)

  await userEvent.click(option(7))

  expect(onChange).toHaveBeenCalledWith(7)
})

test('ArrowRight chooses the next length and moves focus there, wrapping from the last to the first', async () => {
  const onChange = vi.fn()
  render(<BestOfField bestOf={7} onChange={onChange} />)
  option(7).focus()

  await userEvent.keyboard('{ArrowRight}')

  expect(onChange).toHaveBeenCalledWith(1)
  expect(option(1)).toHaveFocus()
})

test('only the chosen length is in the tab order', () => {
  render(<BestOfField bestOf={3} onChange={vi.fn()} />)

  expect(option(3)).toHaveAttribute('tabIndex', '0')
  expect(option(1)).toHaveAttribute('tabIndex', '-1')
})
