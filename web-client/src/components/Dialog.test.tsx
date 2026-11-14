import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import { Button } from './Button.tsx'
import { Dialog } from './Dialog.tsx'

test('a dialog is named by its title and described by its text', () => {
  render(
    <Dialog
      title="Withdraw Okafor from Open singles?"
      actions={<Button variant="danger">Withdraw</Button>}
    >
      His remaining matches go to his opponents as walkovers.
    </Dialog>,
  )

  const dialog = screen.getByRole('dialog', {
    name: 'Withdraw Okafor from Open singles?',
  })
  expect(dialog).toHaveAccessibleDescription(
    'His remaining matches go to his opponents as walkovers.',
  )
  expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
    'Withdraw Okafor from Open singles?',
  )
})
