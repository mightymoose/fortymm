import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import { Field } from './Field.tsx'
import { Select } from './Select.tsx'
import { TextArea } from './TextArea.tsx'
import { TextInput } from '../TextInput.tsx'

test('a field’s label names its control, and its help describes it', () => {
  render(
    <Field label="Club" optional help="Shown next to your name in draws.">
      {(control) => <TextInput {...control} placeholder="Search clubs" />}
    </Field>,
  )
  const input = screen.getByRole('textbox', { name: 'Club (optional)' })

  expect(input).toHaveAccessibleDescription('Shown next to your name in draws.')
  expect(input).toBeValid()
})

test('a field with an error marks its control invalid and describes it with the error, not the help', () => {
  render(
    <Field label="Rating" help="Your club rating." error="Ratings go up to 3,000.">
      {(control) => <TextInput {...control} numeric defaultValue="12000" />}
    </Field>,
  )
  const input = screen.getByRole('textbox', { name: 'Rating' })

  expect(input).toBeInvalid()
  expect(input).toHaveAccessibleDescription('Ratings go up to 3,000.')
  expect(screen.queryByText('Your club rating.')).not.toBeInTheDocument()
})

test('a field whose label is hidden still names its control', () => {
  render(
    <Field label="Table" hideLabel error="Enter 1–6.">
      {(control) => <TextInput {...control} numeric defaultValue="9" />}
    </Field>,
  )

  expect(screen.getByRole('textbox', { name: 'Table' })).toBeInvalid()
})

test('a field names a select or a text area as it names a text input', () => {
  render(
    <>
      <Field label="Event">
        {(control) => (
          <Select {...control}>
            <option>Open singles</option>
          </Select>
        )}
      </Field>
      <Field label="Note to players">
        {(control) => <TextArea {...control} />}
      </Field>
    </>,
  )

  expect(screen.getByRole('combobox', { name: 'Event' })).toBeVisible()
  expect(screen.getByRole('textbox', { name: 'Note to players' })).toBeVisible()
})
