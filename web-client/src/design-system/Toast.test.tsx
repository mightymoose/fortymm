import { render, screen } from '@testing-library/react'
import { describe, expect, vi } from 'vitest'
import { it } from '../setupTests.ts'
import { Toast } from './Toast.tsx'

describe('Toast', () => {
  it('is a status message', () => {
    render(<Toast>Result saved.</Toast>)
    expect(screen.getByRole('status')).toHaveTextContent('Result saved.')
  })

  it('calls onAction when its action is pressed', async ({ user }) => {
    const onAction = vi.fn()
    render(
      <Toast actionLabel="Undo" onAction={onAction}>
        Result saved.
      </Toast>,
    )
    await user.click(screen.getByRole('button', { name: 'Undo' }))
    expect(onAction).toHaveBeenCalledOnce()
  })

  it('has no action without an actionLabel', () => {
    render(<Toast>Result saved.</Toast>)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('calls onDismiss when Dismiss is pressed', async ({ user }) => {
    const onDismiss = vi.fn()
    render(<Toast onDismiss={onDismiss}>Result saved.</Toast>)
    await user.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('has no Dismiss button without onDismiss', () => {
    render(<Toast actionLabel="Undo">Result saved.</Toast>)
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument()
  })
})
