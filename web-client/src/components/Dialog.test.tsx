import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Dialog } from './Dialog'

describe('Dialog', () => {
  it('is a dialog named by its title and described by its description', () => {
    render(<Dialog title="Forfeit?" description="This can't be undone." />)

    const dialog = screen.getByRole('dialog', {
      name: 'Forfeit?',
      description: "This can't be undone.",
    })
    expect(dialog).toHaveClass('dialog')
    expect(dialog).not.toHaveAttribute('aria-modal')
    expect(screen.getByRole('heading', { level: 4 })).toHaveTextContent(
      'Forfeit?',
    )
  })

  it('is an alert dialog as the alert variant', () => {
    render(
      <Dialog variant="alert" title="Delete account" description="Gone." />,
    )

    expect(
      screen.getByRole('alertdialog', {
        name: 'Delete account',
        description: 'Gone.',
      }),
    ).toHaveClass('dialog', 'dialog--alert')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('is a dialog styled as a sheet as the sheet variant', () => {
    render(
      <Dialog variant="sheet" title="Filters" description="Narrow it." />,
    )

    expect(
      screen.getByRole('dialog', {
        name: 'Filters',
        description: 'Narrow it.',
      }),
    ).toHaveClass('sheet')
  })

  it('is a dialog styled as a drawer as the drawer variant', () => {
    render(
      <Dialog variant="drawer" title="Quick log" description="Tap to log." />,
    )

    expect(
      screen.getByRole('dialog', {
        name: 'Quick log',
        description: 'Tap to log.',
      }),
    ).toHaveClass('drawer')
  })

  it('is a dialog styled as a popover as the popover variant', () => {
    render(
      <Dialog variant="popover" title="Skill rating" description="Glicko-2." />,
    )

    expect(
      screen.getByRole('dialog', {
        name: 'Skill rating',
        description: 'Glicko-2.',
      }),
    ).toHaveClass('popover')
  })

  it('shows the body, then the actions in their row', () => {
    render(
      <Dialog
        title="Forfeit?"
        description="Sure?"
        actions={<button type="button">Cancel</button>}
      >
        <p>Body</p>
      </Dialog>,
    )

    const body = screen.getByText('Body')
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    expect(cancel.parentElement).toHaveClass('dialog-actions')
    expect(
      body.compareDocumentPosition(cancel) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('has no actions row without actions', () => {
    const { container } = render(<Dialog title="Note" description="Hi." />)

    expect(container.querySelector('.dialog-actions')).toBeNull()
  })
})
