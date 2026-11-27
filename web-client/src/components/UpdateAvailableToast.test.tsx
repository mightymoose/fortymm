import { render, screen } from '@testing-library/react'
import { describe, expect, vi } from 'vitest'
import { it } from '../setupTests.ts'
import { UpdateAvailableToast } from './UpdateAvailableToast.tsx'

describe('UpdateAvailableToast', () => {
  it('says a new version is available', () => {
    render(<UpdateAvailableToast onReload={() => {}} onDismiss={() => {}} />)
    expect(screen.getByRole('status')).toHaveTextContent('A new version of FortyMM is available.')
  })

  it('reloads when Reload is pressed', async ({ user }) => {
    const onReload = vi.fn()
    render(<UpdateAvailableToast onReload={onReload} onDismiss={() => {}} />)
    await user.click(screen.getByRole('button', { name: 'Reload' }))
    expect(onReload).toHaveBeenCalledOnce()
  })

  it('dismisses when Dismiss is pressed', async ({ user }) => {
    const onDismiss = vi.fn()
    render(<UpdateAvailableToast onReload={() => {}} onDismiss={onDismiss} />)
    await user.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onDismiss).toHaveBeenCalledOnce()
  })
})
