import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { Toast } from './Toast.tsx'

test('a toast is a status message: read out when it shows, without taking focus', () => {
  render(<Toast message="Match saved. Rating +12." />)

  expect(screen.getByRole('status')).toHaveTextContent(
    'Match saved. Rating +12.',
  )
  expect(document.body).toHaveFocus()
})

test('a toast’s action and its dismiss button each do their own thing', async () => {
  const user = userEvent.setup()
  const onAction = vi.fn()
  const onDismiss = vi.fn()
  render(
    <Toast
      message="Match saved."
      action="Undo"
      onAction={onAction}
      onDismiss={onDismiss}
    />,
  )

  await user.click(screen.getByRole('button', { name: 'Undo' }))
  expect(onAction).toHaveBeenCalledOnce()
  expect(onDismiss).not.toHaveBeenCalled()

  await user.click(screen.getByRole('button', { name: 'Dismiss' }))
  expect(onDismiss).toHaveBeenCalledOnce()
})
