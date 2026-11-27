import { render, screen } from '@testing-library/react'
import { describe, expect } from 'vitest'
import { it } from '../setupTests.ts'
import { Checkbox } from './Checkbox.tsx'

describe('Checkbox', () => {
  it('is named by its label', () => {
    render(<Checkbox>Checked in</Checkbox>)
    expect(screen.getByRole('checkbox', { name: 'Checked in' })).toBeInTheDocument()
  })

  it('checks when clicked', async ({ user }) => {
    render(<Checkbox>Checked in</Checkbox>)
    await user.click(screen.getByRole('checkbox', { name: 'Checked in' }))
    expect(screen.getByRole('checkbox', { name: 'Checked in' })).toBeChecked()
  })

  it('checks when its label is clicked', async ({ user }) => {
    render(<Checkbox>Checked in</Checkbox>)
    await user.click(screen.getByText('Checked in'))
    expect(screen.getByRole('checkbox', { name: 'Checked in' })).toBeChecked()
  })

  it('starts checked when selected by default', () => {
    render(<Checkbox defaultSelected>Checked in</Checkbox>)
    expect(screen.getByRole('checkbox', { name: 'Checked in' })).toBeChecked()
  })

  it('is mixed when indeterminate', () => {
    render(<Checkbox isIndeterminate>All players (12 of 16)</Checkbox>)
    expect(screen.getByRole('checkbox', { name: 'All players (12 of 16)' })).toBePartiallyChecked()
  })

  it('is disabled when disabled', () => {
    render(<Checkbox isDisabled>Paid online</Checkbox>)
    expect(screen.getByRole('checkbox', { name: 'Paid online' })).toBeDisabled()
  })
})
