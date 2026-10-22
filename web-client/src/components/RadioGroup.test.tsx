import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState, type ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Field, FieldHelp, Label } from './Field'
import { Radio, RadioGroup } from './RadioGroup'

function MatchFormats(
  props: Omit<ComponentProps<typeof RadioGroup>, 'children'>,
) {
  return (
    <RadioGroup aria-label="Match format" {...props}>
      <Radio value="singles-5">Singles · best of 5</Radio>
      <Radio value="singles-7">Singles · best of 7</Radio>
      <Radio value="doubles-5">Doubles · best of 5</Radio>
    </RadioGroup>
  )
}

function radios() {
  return {
    singles5: screen.getByRole('radio', { name: 'Singles · best of 5' }),
    singles7: screen.getByRole('radio', { name: 'Singles · best of 7' }),
    doubles5: screen.getByRole('radio', { name: 'Doubles · best of 5' }),
  }
}

describe('RadioGroup', () => {
  it('renders a named group of radios inside their labels outside a Field', () => {
    render(<MatchFormats />)

    const group = screen.getByRole('radiogroup', { name: 'Match format' })
    expect(group).toHaveClass('radio-group')
    expect(group).not.toHaveAttribute('aria-labelledby')
    expect(group).not.toHaveAttribute('aria-describedby')
    const options = Object.values(radios())
    const name = options[0].getAttribute('name')
    expect(name).toBeTruthy()
    for (const radio of options) {
      expect(radio).toHaveAttribute('type', 'radio')
      expect(radio).toHaveAttribute('name', name)
      expect(radio).not.toBeChecked()
      expect(radio.closest('label')).toHaveClass('radio')
      for (const attribute of [
        'id',
        'aria-describedby',
        'aria-invalid',
        'required',
        'disabled',
      ]) {
        expect(radio).not.toHaveAttribute(attribute)
      }
    }
    // The dots only draw the inputs' state, so they're hidden from assistive
    // tech.
    for (const dot of document.querySelectorAll('.radio-dot')) {
      expect(dot).toHaveAttribute('aria-hidden', 'true')
    }
  })

  it('gives separate groups separate names unless told one', () => {
    render(
      <>
        <MatchFormats />
        <RadioGroup aria-label="Side" name="side">
          <Radio value="left">Left</Radio>
        </RadioGroup>
      </>,
    )

    expect(radios().singles5.getAttribute('name')).not.toBe('side')
    expect(screen.getByRole('radio', { name: 'Left' })).toHaveAttribute(
      'name',
      'side',
    )
  })

  it('selects an option when its label text is clicked', async () => {
    const user = userEvent.setup()
    render(<MatchFormats defaultValue="singles-5" />)
    const { singles5, singles7, doubles5 } = radios()
    expect(singles5).toBeChecked()

    await user.click(screen.getByText('Singles · best of 7'))
    expect(singles7).toBeChecked()
    expect(singles5).not.toBeChecked()

    await user.click(screen.getByText('Doubles · best of 5'))
    expect(doubles5).toBeChecked()
    expect(singles7).not.toBeChecked()
  })

  it('moves the selection with the arrow keys', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<MatchFormats defaultValue="singles-5" onChange={onChange} />)
    const { singles5, singles7, doubles5 } = radios()

    await user.tab()
    expect(singles5).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(singles7).toBeChecked()
    expect(singles7).toHaveFocus()
    expect(singles5).not.toBeChecked()
    await user.keyboard('{ArrowDown}')
    expect(doubles5).toBeChecked()
    await user.keyboard('{ArrowUp}')
    expect(singles7).toBeChecked()
    expect(onChange.mock.calls).toEqual([
      ['singles-7'],
      ['doubles-5'],
      ['singles-7'],
    ])
  })

  it('can be controlled', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    function Controlled() {
      const [value, setValue] = useState('singles-5')
      return (
        <MatchFormats
          value={value}
          onChange={(next: string) => {
            onChange(next)
            setValue(next)
          }}
        />
      )
    }
    render(<Controlled />)
    const { singles5, doubles5 } = radios()
    expect(singles5).toBeChecked()

    await user.click(screen.getByText('Doubles · best of 5'))
    expect(onChange).toHaveBeenLastCalledWith('doubles-5')
    expect(doubles5).toBeChecked()
    expect(singles5).not.toBeChecked()
  })

  it('stays as its value prop says when onChange ignores the click', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<MatchFormats value="singles-5" onChange={onChange} />)
    const { singles5, singles7 } = radios()

    await user.click(screen.getByText('Singles · best of 7'))
    expect(onChange).toHaveBeenCalledWith('singles-7')
    expect(singles5).toBeChecked()
    expect(singles7).not.toBeChecked()
  })

  it('ignores clicks when the group is disabled', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<MatchFormats disabled defaultValue="singles-5" onChange={onChange} />)
    const { singles5, singles7 } = radios()
    expect(singles7).toBeDisabled()

    await user.click(screen.getByText('Singles · best of 7'))
    await user.click(singles7)
    expect(singles7).not.toBeChecked()
    expect(singles5).toBeChecked()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('ignores clicks on a disabled option', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <RadioGroup aria-label="Match format" onChange={onChange}>
        <Radio value="singles-5">Singles · best of 5</Radio>
        <Radio value="singles-7" disabled>
          Singles · best of 7
        </Radio>
      </RadioGroup>,
    )
    const singles5 = screen.getByRole('radio', { name: 'Singles · best of 5' })
    const singles7 = screen.getByRole('radio', { name: 'Singles · best of 7' })
    expect(singles5).toBeEnabled()
    expect(singles7).toBeDisabled()

    await user.click(screen.getByText('Singles · best of 7'))
    expect(singles7).not.toBeChecked()
    expect(onChange).not.toHaveBeenCalled()

    await user.click(screen.getByText('Singles · best of 5'))
    expect(singles5).toBeChecked()
  })

  it('lets an option enable itself in a disabled group', () => {
    render(
      <RadioGroup aria-label="Match format" disabled>
        <Radio value="singles-5" disabled={false}>
          Singles · best of 5
        </Radio>
        <Radio value="singles-7">Singles · best of 7</Radio>
      </RadioGroup>,
    )

    expect(
      screen.getByRole('radio', { name: 'Singles · best of 5' }),
    ).toBeEnabled()
    expect(
      screen.getByRole('radio', { name: 'Singles · best of 7' }),
    ).toBeDisabled()
  })

  it('passes aria-invalid and required to every option', () => {
    render(<MatchFormats aria-invalid required />)

    const group = screen.getByRole('radiogroup')
    expect(group).not.toHaveAttribute('aria-invalid')
    expect(group).not.toHaveAttribute('required')
    for (const radio of Object.values(radios())) {
      expect(radio).toBeInvalid()
      expect(radio).toBeRequired()
    }
  })

  // A required group is missing a value until any one option is selected,
  // and then none of its options is.
  it('is treated as required by the browser as a whole group', async () => {
    const user = userEvent.setup()
    render(
      <form aria-label="Match">
        <MatchFormats required />
      </form>,
    )
    const form = screen.getByRole('form') as HTMLFormElement
    const options = Object.values(radios()) as HTMLInputElement[]
    expect(form.checkValidity()).toBe(false)
    for (const radio of options) expect(radio.validity.valueMissing).toBe(true)

    await user.click(screen.getByText('Doubles · best of 5'))
    expect(form.checkValidity()).toBe(true)
    for (const radio of options) expect(radio.validity.valueMissing).toBe(false)
  })

  it('submits the selected value under its name', async () => {
    const user = userEvent.setup()
    render(
      <form aria-label="Match">
        <MatchFormats name="format" defaultValue="singles-5" />
      </form>,
    )
    const form = screen.getByRole('form') as HTMLFormElement
    expect(new FormData(form).get('format')).toBe('singles-5')

    await user.click(screen.getByText('Singles · best of 7'))
    expect(new FormData(form).get('format')).toBe('singles-7')
  })

  it('passes other props to the options', () => {
    render(
      <RadioGroup aria-label="Match format">
        <Radio value="singles-5" data-testid="first">
          Singles · best of 5
        </Radio>
      </RadioGroup>,
    )

    expect(screen.getByTestId('first')).toBe(screen.getByRole('radio'))
  })

  it('needs a RadioGroup around its Radios', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<Radio value="a">A</Radio>)).toThrow(
      'A Radio must be inside a RadioGroup.',
    )
    vi.restoreAllMocks()
  })

  it("is named by a Field's Label and takes its state and help text", () => {
    render(
      <Field invalid required>
        <Label>Match format</Label>
        <MatchFormats aria-label={undefined} />
        <FieldHelp>Pick a format to start the match.</FieldHelp>
      </Field>,
    )

    const group = screen.getByRole('radiogroup', { name: 'Match format' })
    expect(group).toHaveAccessibleDescription(
      'Pick a format to start the match.',
    )
    for (const radio of Object.values(radios())) {
      expect(radio).toBeInvalid()
      expect(radio).toBeRequired()
      expect(radio).toBeEnabled()
      // The group, not each option, is described by the help text.
      expect(radio).not.toHaveAttribute('aria-describedby')
    }
  })

  it('is disabled by a disabled Field unless it says otherwise', () => {
    render(
      <>
        <Field disabled>
          <Label>Match format</Label>
          <RadioGroup>
            <Radio value="singles-5">Singles · best of 5</Radio>
          </RadioGroup>
        </Field>
        <Field disabled invalid>
          <Label>Side</Label>
          <RadioGroup disabled={false} aria-invalid={false}>
            <Radio value="left">Left</Radio>
          </RadioGroup>
        </Field>
      </>,
    )

    expect(
      screen.getByRole('radio', { name: 'Singles · best of 5' }),
    ).toBeDisabled()
    const left = screen.getByRole('radio', { name: 'Left' })
    expect(left).toBeEnabled()
    expect(left).not.toBeInvalid()
  })
})
