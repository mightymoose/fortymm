import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { Switch } from './Switch.tsx'

test('pressing a switch turns it on, and pressing again turns it off, telling its listener each time', async () => {
  const user = userEvent.setup()
  const onCheckedChange = vi.fn()
  render(<Switch onCheckedChange={onCheckedChange}>Auto-call</Switch>)
  const control = screen.getByRole('switch', { name: 'Auto-call' })
  expect(control).not.toBeChecked()

  await user.click(control)
  expect(control).toBeChecked()

  await user.click(control)
  expect(control).not.toBeChecked()
  expect(onCheckedChange.mock.calls).toEqual([[true], [false]])
})

test('Space and Enter turn a focused switch on and off', async () => {
  const user = userEvent.setup()
  render(<Switch>Auto-call</Switch>)
  const control = screen.getByRole('switch', { name: 'Auto-call' })

  await user.tab()
  await user.keyboard(' ')
  expect(control).toBeChecked()

  await user.keyboard('{Enter}')
  expect(control).not.toBeChecked()
})

test('a switch given `checked` shows that, whatever was pressed', async () => {
  const user = userEvent.setup()
  render(<Switch checked>Auto-call</Switch>)
  const control = screen.getByRole('switch', { name: 'Auto-call' })
  expect(control).toBeChecked()

  await user.click(control)

  expect(control).toBeChecked()
})

test('a disabled switch does not turn on when pressed', async () => {
  const user = userEvent.setup()
  render(<Switch disabled>Auto-call</Switch>)
  const control = screen.getByRole('switch', { name: 'Auto-call' })

  await user.click(control)

  expect(control).not.toBeChecked()
})
