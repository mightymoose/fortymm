import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Toast } from './Toast'

describe('Toast', () => {
  it('shows its message', () => {
    render(<Toast message="Table 4 marked free" onDismiss={() => {}} />)

    expect(screen.getByText('Table 4 marked free')).toBeVisible()
  })

  it('offers Undo only when it can undo', () => {
    render(<Toast message="Table 4 marked free" onDismiss={() => {}} />)

    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument()
  })

  it('runs onUndo on Undo', async () => {
    const onUndo = vi.fn()
    render(
      <Toast message="Chen vs Ali called to Table 1" onUndo={onUndo} onDismiss={() => {}} />,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Undo' }))

    expect(onUndo).toHaveBeenCalledOnce()
  })

  it('offers Dismiss only when it can be dismissed', () => {
    render(<Toast message="Table 4 marked free" />)

    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument()
  })

  it('runs onDismiss on Dismiss', async () => {
    const onDismiss = vi.fn()
    render(<Toast message="Table 4 marked free" onDismiss={onDismiss} />)

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))

    expect(onDismiss).toHaveBeenCalledOnce()
  })
})
