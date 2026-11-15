import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test } from 'vitest'
import { Checkbox } from './Checkbox.tsx'

test('clicking a checkbox’s label checks it, and clicking again clears it', async () => {
  const user = userEvent.setup()
  render(<Checkbox>Umpire</Checkbox>)
  const checkbox = screen.getByRole('checkbox', { name: 'Umpire' })

  await user.click(screen.getByText('Umpire'))
  expect(checkbox).toBeChecked()

  await user.click(screen.getByText('Umpire'))
  expect(checkbox).not.toBeChecked()
})

test('Space checks a focused checkbox', async () => {
  const user = userEvent.setup()
  render(<Checkbox>Umpire</Checkbox>)

  await user.tab()
  await user.keyboard(' ')

  expect(screen.getByRole('checkbox', { name: 'Umpire' })).toBeChecked()
})

test('a disabled checkbox does not change when clicked', async () => {
  const user = userEvent.setup()
  render(<Checkbox disabled>Umpire</Checkbox>)
  const checkbox = screen.getByRole('checkbox', { name: 'Umpire' })

  await user.click(checkbox)

  expect(checkbox).not.toBeChecked()
})

test('an indeterminate checkbox reads as mixed', () => {
  render(<Checkbox indeterminate>Some</Checkbox>)

  expect(screen.getByRole('checkbox', { name: 'Some' })).toBePartiallyChecked()
})
