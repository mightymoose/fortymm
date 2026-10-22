import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Checkbox } from './Checkbox'
import { Field, FieldHelp } from './Field'

describe('Checkbox', () => {
  it('renders a plain checkbox inside its label outside a Field', () => {
    render(<Checkbox>Email me match invites</Checkbox>)

    const checkbox = screen.getByRole('checkbox', {
      name: 'Email me match invites',
    })
    expect(checkbox).toHaveAttribute('type', 'checkbox')
    expect(checkbox).not.toBeChecked()
    expect(checkbox).not.toBePartiallyChecked()
    expect(checkbox.closest('label')).toHaveClass('checkbox')
    for (const attribute of [
      'id',
      'aria-describedby',
      'aria-invalid',
      'required',
      'disabled',
    ]) {
      expect(checkbox).not.toHaveAttribute(attribute)
    }
    // The box only draws the input's state, so it's hidden from assistive
    // tech.
    expect(document.querySelector('.checkbox-box')).toHaveAttribute(
      'aria-hidden',
      'true',
    )
  })

  it('toggles when its label text is clicked', async () => {
    const user = userEvent.setup()
    render(<Checkbox>Email me match invites</Checkbox>)
    const checkbox = screen.getByRole('checkbox')

    await user.click(screen.getByText('Email me match invites'))
    expect(checkbox).toBeChecked()

    await user.click(screen.getByText('Email me match invites'))
    expect(checkbox).not.toBeChecked()
  })

  it('toggles with Space when focused', async () => {
    const user = userEvent.setup()
    render(<Checkbox defaultChecked>I agree</Checkbox>)
    const checkbox = screen.getByRole('checkbox')

    await user.tab()
    expect(checkbox).toHaveFocus()
    await user.keyboard(' ')
    expect(checkbox).not.toBeChecked()
    await user.keyboard(' ')
    expect(checkbox).toBeChecked()
  })

  it('can be controlled', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    function Controlled() {
      const [checked, setChecked] = useState(false)
      return (
        <Checkbox
          checked={checked}
          onChange={(event) => {
            onChange(event.target.checked)
            setChecked(event.target.checked)
          }}
        >
          I agree
        </Checkbox>
      )
    }
    render(<Controlled />)
    const checkbox = screen.getByRole('checkbox')

    await user.click(checkbox)
    expect(onChange).toHaveBeenLastCalledWith(true)
    expect(checkbox).toBeChecked()

    await user.click(checkbox)
    expect(onChange).toHaveBeenLastCalledWith(false)
    expect(checkbox).not.toBeChecked()
  })

  it('stays as its checked prop says when onChange ignores the click', async () => {
    const user = userEvent.setup()
    render(
      <Checkbox checked onChange={() => {}}>
        I agree
      </Checkbox>,
    )

    await user.click(screen.getByText('I agree'))
    expect(screen.getByRole('checkbox')).toBeChecked()
  })

  it('ignores clicks when disabled', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <Checkbox disabled onChange={onChange}>
        Disabled option
      </Checkbox>,
    )
    const checkbox = screen.getByRole('checkbox', { name: 'Disabled option' })
    expect(checkbox).toBeDisabled()

    await user.click(screen.getByText('Disabled option'))
    await user.click(checkbox)
    expect(checkbox).not.toBeChecked()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('passes its props to the input', () => {
    render(
      <Checkbox aria-invalid required name="terms" value="accepted">
        I agree
      </Checkbox>,
    )

    const checkbox = screen.getByRole('checkbox', { name: 'I agree' })
    expect(checkbox).toBeInvalid()
    expect(checkbox).toBeRequired()
    expect(checkbox).toHaveAttribute('name', 'terms')
    expect(checkbox).toHaveAttribute('value', 'accepted')
  })

  it('shows an indeterminate state', async () => {
    const user = userEvent.setup()
    function Parent() {
      const [checked, setChecked] = useState(false)
      const [indeterminate, setIndeterminate] = useState(true)
      return (
        <Checkbox
          checked={checked}
          indeterminate={indeterminate}
          onChange={(event) => {
            setIndeterminate(false)
            setChecked(event.target.checked)
          }}
        >
          Select all
        </Checkbox>
      )
    }
    render(<Parent />)
    const checkbox = screen.getByRole('checkbox', { name: 'Select all' })
    expect(checkbox).toBePartiallyChecked()
    expect((checkbox as HTMLInputElement).indeterminate).toBe(true)

    await user.click(checkbox)
    expect(checkbox).not.toBePartiallyChecked()
    expect(checkbox).toBeChecked()
  })

  it('stays indeterminate while its prop does', async () => {
    const user = userEvent.setup()
    function Parent() {
      const [checked, setChecked] = useState(false)
      return (
        <Checkbox
          checked={checked}
          indeterminate
          onChange={(event) => setChecked(event.target.checked)}
        >
          Select all
        </Checkbox>
      )
    }
    render(<Parent />)
    const checkbox = screen.getByRole('checkbox')

    await user.click(checkbox)
    expect(checkbox).toBeChecked()
    expect(checkbox).toBePartiallyChecked()
  })

  it('forwards its ref to the input', () => {
    let input: HTMLInputElement | null = null
    render(
      <Checkbox
        ref={(element) => {
          input = element
        }}
      >
        I agree
      </Checkbox>,
    )

    expect(input).toBe(screen.getByRole('checkbox'))
  })

  it("takes a Field's state and help text, keeping its own label", () => {
    render(
      <Field invalid required>
        <Checkbox>I agree to the rules of fair play</Checkbox>
        <FieldHelp>You have to agree to play ranked matches.</FieldHelp>
      </Field>,
    )

    const checkbox = screen.getByRole('checkbox', {
      name: 'I agree to the rules of fair play',
    })
    expect(checkbox).toBeInvalid()
    expect(checkbox).toBeRequired()
    expect(checkbox).toHaveAccessibleDescription(
      'You have to agree to play ranked matches.',
    )
  })

  it("is disabled by a disabled Field unless it says otherwise", () => {
    render(
      <>
        <Field disabled>
          <Checkbox>Email me match invites</Checkbox>
        </Field>
        <Field disabled>
          <Checkbox disabled={false}>Email me results</Checkbox>
        </Field>
      </>,
    )

    expect(
      screen.getByRole('checkbox', { name: 'Email me match invites' }),
    ).toBeDisabled()
    expect(
      screen.getByRole('checkbox', { name: 'Email me results' }),
    ).toBeEnabled()
  })
})
