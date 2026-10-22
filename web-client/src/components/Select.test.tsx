import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Field, FieldHelp, Label } from './Field'
import { Select } from './Select'

describe('Select', () => {
  it('renders a plain select outside a Field', () => {
    render(
      <Select aria-label="Match type">
        <option>Singles</option>
        <option>Doubles</option>
      </Select>,
    )

    const select = screen.getByRole('combobox', { name: 'Match type' })
    expect(select).toHaveClass('select')
    expect(select).toHaveValue('Singles')
    for (const attribute of [
      'id',
      'aria-describedby',
      'aria-invalid',
      'required',
      'disabled',
    ]) {
      expect(select).not.toHaveAttribute(attribute)
    }
  })

  it('adds its className to the select class', () => {
    render(
      <Select aria-label="Match length" className="select-wide">
        <option>Best of 5 games</option>
      </Select>,
    )

    expect(screen.getByRole('combobox')).toHaveAttribute(
      'class',
      'select select-wide',
    )
  })

  it('takes the option the user chooses', async () => {
    const user = userEvent.setup()
    render(
      <Select aria-label="Match type" defaultValue="Doubles">
        <option>Singles</option>
        <option>Doubles</option>
      </Select>,
    )
    const select = screen.getByRole('combobox')
    expect(select).toHaveValue('Doubles')

    await user.selectOptions(select, 'Singles')
    expect(select).toHaveValue('Singles')
  })

  // jsdom doesn't move a select's value on the arrow keys, so the keys are
  // left to the e2e tests.
  it('takes focus from the keyboard', async () => {
    const user = userEvent.setup()
    render(
      <Select aria-label="Match type">
        <option>Singles</option>
        <option>Doubles</option>
      </Select>,
    )

    await user.tab()
    expect(screen.getByRole('combobox')).toHaveFocus()
  })

  it('can be controlled', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    function Controlled() {
      const [value, setValue] = useState('Singles')
      return (
        <Select
          aria-label="Match type"
          value={value}
          onChange={(event) => {
            onChange(event.target.value)
            setValue(event.target.value)
          }}
        >
          <option>Singles</option>
          <option>Doubles</option>
        </Select>
      )
    }
    render(<Controlled />)
    const select = screen.getByRole('combobox')

    await user.selectOptions(select, 'Doubles')
    expect(onChange).toHaveBeenLastCalledWith('Doubles')
    expect(select).toHaveValue('Doubles')

    await user.selectOptions(select, 'Singles')
    expect(onChange).toHaveBeenLastCalledWith('Singles')
    expect(select).toHaveValue('Singles')
  })

  it('stays as its value prop says when onChange ignores the choice', async () => {
    const user = userEvent.setup()
    render(
      <Select aria-label="Match type" value="Singles" onChange={() => {}}>
        <option>Singles</option>
        <option>Doubles</option>
      </Select>,
    )

    await user.selectOptions(screen.getByRole('combobox'), 'Doubles')
    expect(screen.getByRole('combobox')).toHaveValue('Singles')
  })

  // user-event skips a disabled select without throwing.
  it('ignores choices when disabled', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <Select aria-label="Match type" disabled onChange={onChange}>
        <option>Singles</option>
        <option>Doubles</option>
      </Select>,
    )
    const select = screen.getByRole('combobox', { name: 'Match type' })
    expect(select).toBeDisabled()

    await user.selectOptions(select, 'Doubles')
    expect(select).toHaveValue('Singles')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('passes its props to the select', () => {
    render(
      <Select
        aria-label="Match type"
        name="type"
        aria-describedby="type-help"
        aria-invalid
        required
      >
        <option>Singles</option>
      </Select>,
    )

    const select = screen.getByRole('combobox', { name: 'Match type' })
    expect(select).toHaveAttribute('name', 'type')
    expect(select).toHaveAttribute('aria-describedby', 'type-help')
    expect(select).toBeInvalid()
    expect(select).toBeRequired()
  })

  it('forwards its ref to the select', () => {
    let select: HTMLSelectElement | null = null
    render(
      <Select
        aria-label="Match type"
        ref={(element) => {
          select = element
        }}
      >
        <option>Singles</option>
      </Select>,
    )

    expect(select).toBe(screen.getByRole('combobox'))
  })

  it("takes a Field's label, help text and invalid state", () => {
    render(
      <Field invalid>
        <Label>Match type</Label>
        <Select>
          <option>Singles</option>
          <option>Doubles</option>
        </Select>
        <FieldHelp>Pick singles or doubles.</FieldHelp>
      </Field>,
    )

    const select = screen.getByRole('combobox', { name: 'Match type' })
    expect(select).toHaveAccessibleDescription('Pick singles or doubles.')
    expect(select).toBeInvalid()
    expect(select).toHaveAttribute('aria-invalid', 'true')
  })

  // An empty placeholder option is what makes a select's required state mean
  // something: until a real option is chosen, the select is missing a value.
  it('is missing a value in a required Field until an option is chosen', async () => {
    const user = userEvent.setup()
    render(
      <Field required>
        <Label>Match type</Label>
        <Select defaultValue="">
          <option value="">Choose a match type</option>
          <option>Singles</option>
          <option>Doubles</option>
        </Select>
      </Field>,
    )
    const select = screen.getByRole<HTMLSelectElement>('combobox', {
      name: 'Match type',
    })
    expect(select).toBeRequired()
    expect(select.validity.valueMissing).toBe(true)
    expect(select.checkValidity()).toBe(false)

    await user.selectOptions(select, 'Singles')
    expect(select.validity.valueMissing).toBe(false)
    expect(select.checkValidity()).toBe(true)
  })

  it('is disabled by a disabled Field unless it says otherwise', () => {
    render(
      <>
        <Field disabled>
          <Label>Match type</Label>
          <Select>
            <option>Singles</option>
          </Select>
        </Field>
        <Field disabled>
          <Label>Match length</Label>
          <Select disabled={false}>
            <option>Best of 5 games</option>
          </Select>
        </Field>
      </>,
    )

    expect(
      screen.getByRole('combobox', { name: 'Match type' }),
    ).toBeDisabled()
    expect(
      screen.getByRole('combobox', { name: 'Match length' }),
    ).toBeEnabled()
  })
})
