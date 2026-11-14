import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { Button } from './Button.tsx'
import { Icon } from './Icon.tsx'

test('a button runs its action when clicked', async () => {
  const user = userEvent.setup()
  const onClick = vi.fn()
  render(
    <Button variant="primary" onClick={onClick}>
      Call to table
    </Button>,
  )

  await user.click(screen.getByRole('button', { name: 'Call to table' }))

  expect(onClick).toHaveBeenCalledOnce()
})

test('a disabled button does not run its action when clicked', async () => {
  const user = userEvent.setup()
  const onClick = vi.fn()
  render(
    <Button variant="primary" disabled onClick={onClick}>
      Call to table
    </Button>,
  )
  const button = screen.getByRole('button', { name: 'Call to table' })

  await user.click(button)

  expect(button).toBeDisabled()
  expect(onClick).not.toHaveBeenCalled()
})

test('a loading button says it is busy and runs no action when clicked or pressed with Enter', async () => {
  const user = userEvent.setup()
  const onClick = vi.fn()
  render(
    <Button variant="primary" loading onClick={onClick}>
      Saving…
    </Button>,
  )
  const button = screen.getByRole('button', { name: 'Saving…' })

  await user.click(button)
  button.focus()
  await user.keyboard('{Enter}')

  expect(button).toHaveAttribute('aria-busy', 'true')
  expect(onClick).not.toHaveBeenCalled()
})

test('a button that shows only an icon is named by its label', () => {
  render(
    <Button variant="ghost" size="sm" iconOnly aria-label="Close">
      <Icon name="x" size="sm" />
    </Button>,
  )

  expect(screen.getByRole('button', { name: 'Close' })).toBeVisible()
})

test('a button does not submit the form it is in unless asked to', async () => {
  const user = userEvent.setup()
  const onSubmit = vi.fn((event: SubmitEvent) => event.preventDefault())
  render(
    <form onSubmit={(event) => onSubmit(event.nativeEvent as SubmitEvent)}>
      <Button variant="secondary">Reschedule</Button>
    </form>,
  )

  await user.click(screen.getByRole('button', { name: 'Reschedule' }))

  expect(onSubmit).not.toHaveBeenCalled()
})
