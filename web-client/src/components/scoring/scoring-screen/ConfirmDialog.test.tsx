import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { ConfirmDialog } from './ConfirmDialog.tsx'

function renderDialog() {
  const onGo = vi.fn()
  const onStay = vi.fn()
  render(
    <ConfirmDialog
      title="Clear game 2?"
      stayLabel="Keep score"
      goLabel="Clear game"
      onGo={onGo}
      onStay={onStay}
    >
      This deletes the saved score.
    </ConfirmDialog>,
  )
  const dialog = screen.getByRole('dialog', { name: 'Clear game 2?' })
  return { onGo, onStay, dialog }
}

test('a dialog named by its title, described by its text, with the safe answer focused', () => {
  const { dialog } = renderDialog()

  expect(dialog).toHaveAccessibleDescription('This deletes the saved score.')
  expect(screen.getByRole('button', { name: 'Keep score' })).toHaveFocus()
})

test('the safe answer stays; the other goes', async () => {
  const user = userEvent.setup()
  const { onGo, onStay } = renderDialog()

  await user.click(screen.getByRole('button', { name: 'Keep score' }))
  expect(onStay).toHaveBeenCalledTimes(1)
  expect(onGo).not.toHaveBeenCalled()

  await user.click(screen.getByRole('button', { name: 'Clear game' }))
  expect(onGo).toHaveBeenCalledTimes(1)
})

test('Escape, or a press on the backdrop, stays and never goes', async () => {
  const user = userEvent.setup()
  const { onGo, onStay, dialog } = renderDialog()

  await user.keyboard('{Escape}')
  await user.click(dialog.parentElement!)

  expect(onStay).toHaveBeenCalledTimes(2)
  expect(onGo).not.toHaveBeenCalled()
})
