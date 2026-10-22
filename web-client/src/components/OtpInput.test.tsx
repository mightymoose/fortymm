import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { Field, FieldHelp, Label } from './Field'
import { OtpInput } from './OtpInput'

// The characters the cells show, an empty string for an empty cell.
function cells(): string[] {
  return Array.from(document.querySelectorAll('.otp-cell'), (cell) =>
    cell.textContent ?? '',
  )
}

// The index of the active cell, or -1 if none is.
function activeCell(): number {
  return Array.from(document.querySelectorAll('.otp-cell')).findIndex((cell) =>
    cell.classList.contains('otp-cell--active'),
  )
}

describe('OtpInput', () => {
  it('renders one plain input and six cells outside a Field', () => {
    render(<OtpInput aria-label="Code" defaultValue="40MM" />)

    const input = screen.getByRole('textbox', { name: 'Code' })
    expect(input).toHaveValue('40MM')
    expect(input).toHaveAttribute('autocomplete', 'one-time-code')
    expect(input).toHaveAttribute('inputmode', 'text')
    for (const attribute of [
      'id',
      'aria-describedby',
      'aria-invalid',
      'required',
      'disabled',
    ]) {
      expect(input).not.toHaveAttribute(attribute)
    }
    expect(cells()).toEqual(['4', '0', 'M', 'M', '', ''])
    // The cells only show the input's value, so they're hidden from
    // assistive tech, and no cell is active until the input is focused.
    for (const cell of document.querySelectorAll('.otp-cell')) {
      expect(cell).toHaveAttribute('aria-hidden', 'true')
    }
    expect(activeCell()).toBe(-1)
  })

  it('renders `length` cells', () => {
    render(<OtpInput aria-label="Code" length={4} />)

    expect(cells()).toEqual(['', '', '', ''])
  })

  it('takes its label, description and state from a Field', () => {
    render(
      <Field invalid required disabled>
        <Label>Verification code</Label>
        <OtpInput />
        <FieldHelp>Check your email for the code.</FieldHelp>
      </Field>,
    )

    // The label's asterisk isn't part of the input's name.
    const input = screen.getByRole('textbox', { name: 'Verification code' })
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toBeInvalid()
    expect(input).toBeRequired()
    expect(input).toBeDisabled()
    expect(input).toHaveAccessibleDescription('Check your email for the code.')
  })

  it('lets its own props win over the field’s', () => {
    render(
      <Field invalid required disabled>
        <Label>Verification code</Label>
        <OtpInput aria-invalid={false} required={false} disabled={false} />
      </Field>,
    )

    const input = screen.getByRole('textbox', { name: 'Verification code' })
    expect(input).toHaveAttribute('aria-invalid', 'false')
    expect(input).not.toBeRequired()
    expect(input).toBeEnabled()
  })

  it('fills the cells in order as you type, up to `length`', async () => {
    const user = userEvent.setup()
    render(<OtpInput aria-label="Code" />)
    const input = screen.getByRole('textbox', { name: 'Code' })

    await user.type(input, '40')
    expect(cells()).toEqual(['4', '0', '', '', '', ''])

    await user.type(input, 'MM1234')
    expect(input).toHaveValue('40MM12')
    expect(cells()).toEqual(['4', '0', 'M', 'M', '1', '2'])
  })

  it('ignores characters a code can’t hold', async () => {
    const user = userEvent.setup()
    render(<OtpInput aria-label="Code" />)

    await user.type(screen.getByRole('textbox', { name: 'Code' }), '4 0-M!')

    expect(cells()).toEqual(['4', '0', 'M', '', '', ''])
  })

  it('fills every cell from a pasted code', async () => {
    const user = userEvent.setup()
    render(<OtpInput aria-label="Code" />)
    const input = screen.getByRole('textbox', { name: 'Code' })

    await user.click(input)
    await user.paste('40MM12')

    expect(input).toHaveValue('40MM12')
    expect(cells()).toEqual(['4', '0', 'M', 'M', '1', '2'])
  })

  it('keeps a pasted code’s characters and drops its separators and extras', async () => {
    const user = userEvent.setup()
    render(<OtpInput aria-label="Code" />)
    const input = screen.getByRole('textbox', { name: 'Code' })

    await user.click(input)
    await user.paste(' 40-MM 1234 ')

    expect(input).toHaveValue('40MM12')
  })

  it('clears the last character with Backspace', async () => {
    const user = userEvent.setup()
    render(<OtpInput aria-label="Code" defaultValue="40MM" />)
    const input = screen.getByRole('textbox', { name: 'Code' })

    await user.click(input)
    await user.keyboard('{Backspace}')
    expect(input).toHaveValue('40M')
    expect(cells()).toEqual(['4', '0', 'M', '', '', ''])

    await user.keyboard('{Backspace}{Backspace}{Backspace}{Backspace}')
    expect(input).toHaveValue('')
  })

  it('makes the next empty cell active while focused', async () => {
    const user = userEvent.setup()
    render(<OtpInput aria-label="Code" defaultValue="40MM" />)
    const input = screen.getByRole('textbox', { name: 'Code' })

    await user.click(input)
    expect(activeCell()).toBe(4)

    await user.keyboard('1')
    expect(activeCell()).toBe(5)

    // A full code leaves the last cell active.
    await user.keyboard('2')
    expect(activeCell()).toBe(5)

    await user.tab()
    expect(activeCell()).toBe(-1)
  })

  it('moves the active cell with the arrow keys, and replaces the character there', async () => {
    const user = userEvent.setup()
    render(<OtpInput aria-label="Code" defaultValue="40MM" />)
    const input = screen.getByRole('textbox', { name: 'Code' })

    await user.click(input)
    await user.keyboard('{ArrowLeft}{ArrowLeft}')
    expect(activeCell()).toBe(2)

    await user.keyboard('{ArrowRight}')
    expect(activeCell()).toBe(3)

    // Typing on a filled cell replaces its character and moves on.
    await user.keyboard('X')
    expect(input).toHaveValue('40MX')
    expect(activeCell()).toBe(4)

    // The active cell stops at the first cell and at the next empty one.
    await user.keyboard('{ArrowRight}')
    expect(activeCell()).toBe(4)
    await user.keyboard('{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}')
    expect(activeCell()).toBe(0)
  })

  it('shows `activeIndex` as active until focused', async () => {
    const user = userEvent.setup()
    render(<OtpInput aria-label="Code" defaultValue="40MM" activeIndex={3} />)

    expect(activeCell()).toBe(3)

    await user.click(screen.getByRole('textbox', { name: 'Code' }))
    expect(activeCell()).toBe(4)

    await user.tab()
    expect(activeCell()).toBe(3)
  })

  it('can be controlled', async () => {
    const user = userEvent.setup()
    function Controlled() {
      const [code, setCode] = useState('4')
      return (
        <>
          <OtpInput
            aria-label="Code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
          <output>{code}</output>
        </>
      )
    }
    render(<Controlled />)

    await user.type(screen.getByRole('textbox', { name: 'Code' }), '0-M')

    expect(screen.getByRole('status')).toHaveTextContent('40M')
    expect(cells()).toEqual(['4', '0', 'M', '', '', ''])
  })

  it('ignores typing while disabled', async () => {
    const user = userEvent.setup()
    render(<OtpInput aria-label="Code" disabled />)
    const input = screen.getByRole('textbox', { name: 'Code' })

    await user.type(input, '40')

    expect(input).toHaveValue('')
  })
})
