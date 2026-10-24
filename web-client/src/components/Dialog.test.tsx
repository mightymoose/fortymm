import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Button } from './Button'
import { closeDialog } from './closeDialog'
import { Dialog } from './Dialog'

function WithdrawDemo({ onClose }: { onClose: (returnValue: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  return (
    <>
      <Button variant="danger" onClick={() => dialog.current?.showModal()}>
        Withdraw player…
      </Button>
      <Dialog
        ref={dialog}
        title="Withdraw Okafor-Adeyemi from the draw?"
        onClose={(event) => onClose(event.currentTarget.returnValue)}
        actions={
          <>
            <Button variant="secondary" onClick={closeDialog}>
              Keep in draw
            </Button>
            <Button variant="danger-solid" value="withdraw" onClick={closeDialog}>
              Withdraw
            </Button>
          </>
        }
      >
        <p>Johansen-Whitfield advances to the quarterfinal.</p>
      </Dialog>
    </>
  )
}

describe('Dialog', () => {
  it('opens named by its title', async () => {
    const user = userEvent.setup()
    render(<WithdrawDemo onClose={() => {}} />)

    await user.click(screen.getByRole('button', { name: 'Withdraw player…' }))

    expect(
      screen.getByRole('dialog', { name: 'Withdraw Okafor-Adeyemi from the draw?' }),
    ).toHaveTextContent('Johansen-Whitfield advances to the quarterfinal.')
  })

  it.each([
    ['Keep in draw', ''],
    ['Withdraw', 'withdraw'],
  ])('closes on %s, with its value', async (name, returnValue) => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<WithdrawDemo onClose={onClose} />)
    await user.click(screen.getByRole('button', { name: 'Withdraw player…' }))

    await user.click(screen.getByRole('button', { name }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(onClose).toHaveBeenCalledWith(returnValue)
  })

  it('closes on a click on the backdrop', async () => {
    const user = userEvent.setup()
    render(<WithdrawDemo onClose={() => {}} />)
    await user.click(screen.getByRole('button', { name: 'Withdraw player…' }))

    // The backdrop takes clicks for the dialog: they land on it, outside
    // its box.
    await user.pointer({
      keys: '[MouseLeft]',
      target: screen.getByRole('dialog'),
      coords: { clientX: 5, clientY: 5 },
    })

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('stays open on a click inside it', async () => {
    const user = userEvent.setup()
    render(<WithdrawDemo onClose={() => {}} />)
    await user.click(screen.getByRole('button', { name: 'Withdraw player…' }))

    await user.click(screen.getByText('Johansen-Whitfield advances to the quarterfinal.'))

    expect(screen.getByRole('dialog')).toBeVisible()
  })
})
