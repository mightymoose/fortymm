import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Field, FieldHelp } from './Field'
import { Switch } from './Switch'

describe('Switch', () => {
  it('renders a plain switch inside its label outside a Field', () => {
    render(<Switch>Public profile</Switch>)

    const toggle = screen.getByRole('switch', {
      name: 'Public profile',
      checked: false,
    })
    expect(toggle).toHaveAttribute('type', 'checkbox')
    expect(toggle.closest('label')).toHaveClass('switch')
    for (const attribute of [
      'id',
      'aria-describedby',
      'aria-invalid',
      'required',
      'disabled',
    ]) {
      expect(toggle).not.toHaveAttribute(attribute)
    }
    // The track only draws the input's state, so it's hidden from assistive
    // tech.
    expect(document.querySelector('.switch-track')).toHaveAttribute(
      'aria-hidden',
      'true',
    )
  })

  it('toggles when its label text is clicked', async () => {
    const user = userEvent.setup()
    render(<Switch>Public profile</Switch>)
    const toggle = screen.getByRole('switch')

    await user.click(screen.getByText('Public profile'))
    expect(toggle).toBeChecked()

    await user.click(screen.getByText('Public profile'))
    expect(toggle).not.toBeChecked()
  })

  it('toggles with Space when focused', async () => {
    const user = userEvent.setup()
    render(<Switch defaultChecked>Public profile</Switch>)
    const toggle = screen.getByRole('switch')

    await user.tab()
    expect(toggle).toHaveFocus()
    await user.keyboard(' ')
    expect(toggle).not.toBeChecked()
    await user.keyboard(' ')
    expect(toggle).toBeChecked()
  })

  it('can be controlled', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    function Controlled() {
      const [checked, setChecked] = useState(false)
      return (
        <Switch
          checked={checked}
          onChange={(event) => {
            onChange(event.target.checked)
            setChecked(event.target.checked)
          }}
        >
          Public profile
        </Switch>
      )
    }
    render(<Controlled />)
    const toggle = screen.getByRole('switch')

    await user.click(toggle)
    expect(onChange).toHaveBeenLastCalledWith(true)
    expect(toggle).toBeChecked()

    await user.click(toggle)
    expect(onChange).toHaveBeenLastCalledWith(false)
    expect(toggle).not.toBeChecked()
  })

  it('stays as its checked prop says when onChange ignores the click', async () => {
    const user = userEvent.setup()
    render(
      <Switch checked onChange={() => {}}>
        Public profile
      </Switch>,
    )

    await user.click(screen.getByText('Public profile'))
    expect(screen.getByRole('switch')).toBeChecked()
  })

  it('ignores clicks when disabled', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <Switch disabled onChange={onChange}>
        Public profile
      </Switch>,
    )
    const toggle = screen.getByRole('switch', { name: 'Public profile' })
    expect(toggle).toBeDisabled()

    await user.click(screen.getByText('Public profile'))
    await user.click(toggle)
    expect(toggle).not.toBeChecked()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('passes its props to the input', () => {
    render(
      <Switch name="profile" value="public" aria-describedby="profile-help">
        Public profile
      </Switch>,
    )

    const toggle = screen.getByRole('switch', { name: 'Public profile' })
    expect(toggle).toHaveAttribute('name', 'profile')
    expect(toggle).toHaveAttribute('value', 'public')
    expect(toggle).toHaveAttribute('aria-describedby', 'profile-help')
  })

  it('forwards its ref to the input', () => {
    let input: HTMLInputElement | null = null
    render(
      <Switch
        ref={(element) => {
          input = element
        }}
      >
        Public profile
      </Switch>,
    )

    expect(input).toBe(screen.getByRole('switch'))
  })

  it("takes a Field's help text, keeping its own label", () => {
    render(
      <Field>
        <Switch>Public profile</Switch>
        <FieldHelp>Anyone can see your matches.</FieldHelp>
      </Field>,
    )

    expect(
      screen.getByRole('switch', { name: 'Public profile' }),
    ).toHaveAccessibleDescription('Anyone can see your matches.')
  })

  // Either state of a switch is a valid choice, so it's never required or
  // invalid, even in a Field that is.
  it("ignores an invalid or required Field's state", () => {
    render(
      <Field invalid required>
        <Switch>Public profile</Switch>
        <FieldHelp>Anyone can see your matches.</FieldHelp>
      </Field>,
    )

    const toggle = screen.getByRole('switch', { name: 'Public profile' })
    expect(toggle).toBeValid()
    expect(toggle).not.toBeRequired()
    expect(toggle).not.toHaveAttribute('aria-invalid')
  })

  it('is disabled by a disabled Field unless it says otherwise', () => {
    render(
      <>
        <Field disabled>
          <Switch>Public profile</Switch>
        </Field>
        <Field disabled>
          <Switch disabled={false}>Notify me of nearby matches</Switch>
        </Field>
      </>,
    )

    expect(screen.getByRole('switch', { name: 'Public profile' })).toBeDisabled()
    expect(
      screen.getByRole('switch', { name: 'Notify me of nearby matches' }),
    ).toBeEnabled()
  })
})
