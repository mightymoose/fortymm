import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { DiscardChangesDialog } from './DiscardChangesDialog.tsx'

function dialog() {
  return screen.getByRole('dialog', { name: 'Discard changes?' })
}

test('a dialog named “Discard changes?”, described by what leaving loses, with Keep editing focused', () => {
  render(<DiscardChangesDialog onLeave={vi.fn()} onStay={vi.fn()} />)

  expect(dialog()).toHaveAccessibleDescription(
    'You’ve named an opponent or changed the match settings. Leaving now discards them.',
  )
  expect(screen.getByRole('button', { name: 'Keep editing' })).toHaveFocus()
})

test('Discard & leave leaves; Keep editing stays', async () => {
  const onLeave = vi.fn()
  const onStay = vi.fn()
  render(<DiscardChangesDialog onLeave={onLeave} onStay={onStay} />)

  await userEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
  expect(onStay).toHaveBeenCalledTimes(1)
  expect(onLeave).not.toHaveBeenCalled()

  await userEvent.click(screen.getByRole('button', { name: 'Discard & leave' }))
  expect(onLeave).toHaveBeenCalledTimes(1)
})

test('Escape, or a press on the backdrop, stays and never leaves', async () => {
  const onLeave = vi.fn()
  const onStay = vi.fn()
  render(<DiscardChangesDialog onLeave={onLeave} onStay={onStay} />)

  await userEvent.keyboard('{Escape}')
  await userEvent.click(dialog().parentElement!)

  expect(onStay).toHaveBeenCalledTimes(2)
  expect(onLeave).not.toHaveBeenCalled()
})

test('a press inside the dialog, off its buttons, does nothing', async () => {
  const onStay = vi.fn()
  render(<DiscardChangesDialog onLeave={vi.fn()} onStay={onStay} />)

  await userEvent.click(dialog())

  expect(onStay).not.toHaveBeenCalled()
})
