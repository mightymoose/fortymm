import { render, screen } from '@testing-library/react'
import { describe, expect } from 'vitest'
import { it } from '../setupTests.ts'
import { Switch } from './Switch.tsx'

describe('Switch', () => {
  it('is a switch named by its label', () => {
    render(<Switch>Call players automatically</Switch>)
    expect(screen.getByRole('switch', { name: 'Call players automatically' })).toBeInTheDocument()
  })

  it('starts on when selected by default', () => {
    render(<Switch defaultSelected>Call players automatically</Switch>)
    expect(screen.getByRole('switch', { name: 'Call players automatically' })).toBeChecked()
  })

  it('turns on when pressed', async ({ user }) => {
    render(<Switch>Call players automatically</Switch>)
    await user.click(screen.getByRole('switch', { name: 'Call players automatically' }))
    expect(screen.getByRole('switch', { name: 'Call players automatically' })).toBeChecked()
  })

  it('turns off when pressed again', async ({ user }) => {
    render(<Switch defaultSelected>Call players automatically</Switch>)
    await user.click(screen.getByRole('switch', { name: 'Call players automatically' }))
    expect(screen.getByRole('switch', { name: 'Call players automatically' })).not.toBeChecked()
  })

  it('is disabled when disabled', () => {
    render(<Switch isDisabled>Text players</Switch>)
    expect(screen.getByRole('switch', { name: 'Text players' })).toBeDisabled()
  })
})
