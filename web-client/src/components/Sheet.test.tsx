import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useRef } from 'react'
import { describe, expect, it } from 'vitest'
import { Button } from './Button'
import { Sheet } from './Sheet'

function DrawerDemo() {
  const sheet = useRef<HTMLDialogElement>(null)
  return (
    <>
      <Button variant="secondary" onClick={() => sheet.current?.showModal()}>
        Open match drawer
      </Button>
      <Sheet
        ref={sheet}
        title="Patel vs Wójcik-Szymańska"
        subtitle="Table 3 · Open singles · Round of 32"
        footer={<a href="#scoring">Open scoring</a>}
      >
        <p>Started 11:05</p>
      </Sheet>
    </>
  )
}

describe('Sheet', () => {
  it('opens named by its title, with its subtitle, body and footer', async () => {
    const user = userEvent.setup()
    render(<DrawerDemo />)

    await user.click(screen.getByRole('button', { name: 'Open match drawer' }))

    const sheet = screen.getByRole('dialog', { name: 'Patel vs Wójcik-Szymańska' })
    expect(sheet).toHaveTextContent('Table 3 · Open singles · Round of 32')
    expect(sheet).toHaveTextContent('Started 11:05')
    expect(screen.getByRole('link', { name: 'Open scoring' })).toBeVisible()
  })

  it('closes on Close', async () => {
    const user = userEvent.setup()
    render(<DrawerDemo />)
    await user.click(screen.getByRole('button', { name: 'Open match drawer' }))

    await user.click(screen.getByRole('button', { name: 'Close' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
