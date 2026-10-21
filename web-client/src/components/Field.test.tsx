import { render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { Field, FieldHelp, Label } from './Field'
import { Input } from './Input'

describe('Field', () => {
  it('labels its control', () => {
    render(
      <Field>
        <Label>Name</Label>
        <Input />
      </Field>,
    )

    expect(screen.getByRole('textbox', { name: 'Name' })).toBeInTheDocument()
  })

  it('describes its control only once help text is rendered', async () => {
    function Toggle() {
      const [showHelp, setShowHelp] = useState(false)
      return (
        <>
          <button onClick={() => setShowHelp(!showHelp)}>Toggle help</button>
          <Field>
            <Label>Name</Label>
            <Input />
            {showHelp && <FieldHelp>As on your licence.</FieldHelp>}
          </Field>
        </>
      )
    }
    render(<Toggle />)
    const input = screen.getByRole('textbox', { name: 'Name' })
    expect(input).not.toHaveAccessibleDescription()

    screen.getByRole('button').click()
    expect(
      await screen.findByText('As on your licence.'),
    ).toBeInTheDocument()
    expect(input).toHaveAccessibleDescription('As on your licence.')

    screen.getByRole('button').click()
    await expect.poll(() => input.hasAttribute('aria-describedby')).toBe(false)
  })

  it('marks a required label without changing its name', () => {
    render(
      <Field required>
        <Label>Email</Label>
        <Input />
      </Field>,
    )

    const input = screen.getByRole('textbox', { name: 'Email' })
    expect(input).toBeRequired()
    expect(screen.getByText('*')).toHaveAttribute('aria-hidden', 'true')
  })

  it('passes its invalid and disabled state to the control', () => {
    render(
      <Field invalid disabled>
        <Label>Email</Label>
        <Input />
        <FieldHelp>Enter a valid email address.</FieldHelp>
      </Field>,
    )

    const input = screen.getByRole('textbox', { name: 'Email' })
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toBeDisabled()
    expect(screen.getByText('Enter a valid email address.')).toHaveClass(
      'field-help--error',
    )
  })

  it('lets the control’s own props win over the field’s', () => {
    render(
      <Field invalid required>
        <Label>Email</Label>
        <Input aria-invalid={false} required={false} />
      </Field>,
    )

    const input = screen.getByRole('textbox', { name: 'Email' })
    expect(input).toHaveAttribute('aria-invalid', 'false')
    expect(input).not.toBeRequired()
  })

  it('gives each field its own ids', () => {
    render(
      <>
        <Field>
          <Label>First</Label>
          <Input />
        </Field>
        <Field>
          <Label>Second</Label>
          <Input />
        </Field>
      </>,
    )

    expect(screen.getByRole('textbox', { name: 'First' }).id).not.toBe(
      screen.getByRole('textbox', { name: 'Second' }).id,
    )
  })
})
