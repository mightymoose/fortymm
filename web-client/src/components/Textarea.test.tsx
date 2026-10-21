import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Field, FieldHelp, Label } from './Field'
import { Textarea } from './Textarea'

describe('Textarea', () => {
  it('renders a plain textarea outside a Field', () => {
    render(<Textarea aria-label="Notes" defaultValue="Back hall" />)

    const textarea = screen.getByRole('textbox', { name: 'Notes' })
    expect(textarea.tagName).toBe('TEXTAREA')
    expect(textarea).toHaveClass('textarea')
    expect(textarea).toHaveValue('Back hall')
    for (const attribute of [
      'id',
      'aria-describedby',
      'aria-invalid',
      'required',
      'disabled',
    ]) {
      expect(textarea).not.toHaveAttribute(attribute)
    }
  })

  it('takes its label, description and state from a Field', () => {
    render(
      <Field invalid required disabled>
        <Label>Match notes</Label>
        <Textarea />
        <FieldHelp>Keep it under 500 characters.</FieldHelp>
      </Field>,
    )

    // The label's asterisk isn't part of the textarea's name.
    const textarea = screen.getByRole('textbox', { name: 'Match notes' })
    expect(textarea).toHaveAttribute('aria-invalid', 'true')
    expect(textarea).toBeInvalid()
    expect(textarea).toBeRequired()
    expect(textarea).toBeDisabled()
    expect(textarea).toHaveAccessibleDescription(
      'Keep it under 500 characters.',
    )
  })

  it('lets its own props win over the field’s', () => {
    render(
      <Field invalid required>
        <Label>Match notes</Label>
        <Textarea aria-invalid={false} required={false} />
      </Field>,
    )

    const textarea = screen.getByRole('textbox', { name: 'Match notes' })
    expect(textarea).toHaveAttribute('aria-invalid', 'false')
    expect(textarea).not.toBeRequired()
  })
})
