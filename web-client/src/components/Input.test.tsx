import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Input } from './Input'

describe('Input', () => {
  it('renders a plain input outside a Field', () => {
    render(<Input aria-label="Search" defaultValue="Brooklyn" />)

    const input = screen.getByRole('textbox', { name: 'Search' })
    expect(input).toHaveClass('input')
    expect(input).toHaveValue('Brooklyn')
    for (const attribute of [
      'id',
      'aria-describedby',
      'aria-invalid',
      'required',
      'disabled',
    ]) {
      expect(input).not.toHaveAttribute(attribute)
    }
  })

  it('passes its props to the input', () => {
    render(<Input aria-label="Email" type="email" aria-invalid disabled />)

    const input = screen.getByRole('textbox', { name: 'Email' })
    expect(input).toHaveAttribute('type', 'email')
    expect(input).toBeInvalid()
    expect(input).toBeDisabled()
  })
})
