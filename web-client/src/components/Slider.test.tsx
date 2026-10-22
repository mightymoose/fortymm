import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Field, FieldHelp } from './Field'
import { Slider, type SliderValue } from './Slider'

// jsdom has no range input behaviour: the keys and the pointer don't move
// it. The browser runs those (e2e/design-system.spec.ts), so these tests set
// an input's value the way the browser does when it moves, with a change
// event.
function move(slider: HTMLElement, value: number) {
  fireEvent.change(slider, { target: { value: String(value) } })
}

function readout() {
  return screen.getByRole('status')
}

describe('Slider', () => {
  it('renders one slider, named by its label, with its value shown', () => {
    render(
      <Slider min={1070} max={2070} step={10} defaultValue={1620}>
        Skill level
      </Slider>,
    )

    const slider = screen.getByRole('slider', { name: 'Skill level' })
    expect(slider).toHaveValue('1620')
    expect(slider).toHaveAttribute('min', '1070')
    expect(slider).toHaveAttribute('max', '2070')
    expect(slider).toHaveAttribute('step', '10')
    expect(readout()).toHaveTextContent(/^1620$/)
    for (const attribute of ['aria-describedby', 'required', 'disabled']) {
      expect(slider).not.toHaveAttribute(attribute)
    }
    // The track and thumb only draw the input's value, so they're hidden
    // from assistive tech.
    for (const drawn of document.querySelectorAll(
      '.slider-track, .slider-thumb',
    )) {
      expect(drawn).toHaveAttribute('aria-hidden', 'true')
    }
  })

  it('updates the readout as it moves', () => {
    const onValueChange = vi.fn()
    render(
      <Slider
        min={1070}
        max={2070}
        step={10}
        defaultValue={1620}
        onValueChange={onValueChange}
      >
        Skill level
      </Slider>,
    )
    const slider = screen.getByRole('slider', { name: 'Skill level' })

    move(slider, 1630)

    expect(slider).toHaveValue('1630')
    expect(readout()).toHaveTextContent(/^1630$/)
    expect(onValueChange).toHaveBeenLastCalledWith(1630)
  })

  it('renders two sliders for a range, named for its ends', () => {
    render(
      <Slider min={1100} max={2100} step={10} defaultValue={[1400, 1800]}>
        Rating range
      </Slider>,
    )

    expect(
      screen.getByRole('slider', { name: 'Rating range minimum' }),
    ).toHaveValue('1400')
    expect(
      screen.getByRole('slider', { name: 'Rating range maximum' }),
    ).toHaveValue('1800')
    expect(readout()).toHaveTextContent(/^1400 – 1800$/)
  })

  it("stops each of a range's thumbs at the other", () => {
    const onValueChange = vi.fn()
    render(
      <Slider
        min={1100}
        max={2100}
        step={10}
        defaultValue={[1400, 1800]}
        onValueChange={onValueChange}
      >
        Rating range
      </Slider>,
    )
    const low = screen.getByRole('slider', { name: 'Rating range minimum' })
    const high = screen.getByRole('slider', { name: 'Rating range maximum' })

    move(low, 2000)
    expect(low).toHaveValue('1800')
    expect(onValueChange).toHaveBeenLastCalledWith([1800, 1800])

    move(high, 1200)
    expect(high).toHaveValue('1800')
    expect(readout()).toHaveTextContent(/^1800 – 1800$/)

    move(high, 2000)
    move(low, 1500)
    expect(readout()).toHaveTextContent(/^1500 – 2000$/)
    expect(onValueChange).toHaveBeenLastCalledWith([1500, 2000])
  })

  it('can be controlled', () => {
    const onValueChange = vi.fn()
    function Controlled() {
      const [value, setValue] = useState<SliderValue>([1400, 1800])
      return (
        <Slider
          min={1100}
          max={2100}
          value={value}
          onValueChange={(next) => {
            onValueChange(next)
            setValue(next)
          }}
        >
          Rating range
        </Slider>
      )
    }
    render(<Controlled />)
    const low = screen.getByRole('slider', { name: 'Rating range minimum' })

    move(low, 1500)

    expect(onValueChange).toHaveBeenLastCalledWith([1500, 1800])
    expect(low).toHaveValue('1500')
    expect(readout()).toHaveTextContent(/^1500 – 1800$/)
  })

  it('stays as its value prop says when onValueChange ignores a move', () => {
    render(
      <Slider min={1070} max={2070} value={1620} onValueChange={() => {}}>
        Skill level
      </Slider>,
    )
    const slider = screen.getByRole('slider', { name: 'Skill level' })

    move(slider, 1700)

    expect(slider).toHaveValue('1620')
    expect(readout()).toHaveTextContent(/^1620$/)
  })

  it('disables every input when disabled', () => {
    render(
      <Slider min={1100} max={2100} defaultValue={[1400, 1800]} disabled>
        Rating range
      </Slider>,
    )

    for (const slider of screen.getAllByRole('slider')) {
      expect(slider).toBeDisabled()
    }
  })

  it("takes a Field's help text on every input, keeping its own label", () => {
    render(
      <Field>
        <Slider min={1100} max={2100} defaultValue={[1400, 1800]}>
          Rating range
        </Slider>
        <FieldHelp>Players you can be matched with.</FieldHelp>
      </Field>,
    )

    const sliders = screen.getAllByRole('slider')
    expect(sliders).toHaveLength(2)
    for (const slider of sliders) {
      expect(slider).toHaveAccessibleDescription(
        'Players you can be matched with.',
      )
    }
    // The Field's control id goes to one input only.
    expect(sliders[0].id).not.toBe(sliders[1].id)
  })

  // A slider always holds a value between its min and max, so it's never
  // required or invalid, even in a Field that is.
  it("ignores an invalid or required Field's state", () => {
    render(
      <Field invalid required>
        <Slider min={1070} max={2070} defaultValue={1620}>
          Skill level
        </Slider>
      </Field>,
    )

    const slider = screen.getByRole('slider', { name: 'Skill level' })
    expect(slider).toBeValid()
    expect(slider).not.toBeRequired()
    expect(slider).not.toHaveAttribute('aria-invalid')
  })

  it('is disabled by a disabled Field unless it says otherwise', () => {
    render(
      <>
        <Field disabled>
          <Slider min={1070} max={2070} defaultValue={1620}>
            Skill level
          </Slider>
        </Field>
        <Field disabled>
          <Slider min={1070} max={2070} defaultValue={1620} disabled={false}>
            Match length
          </Slider>
        </Field>
      </>,
    )

    expect(screen.getByRole('slider', { name: 'Skill level' })).toBeDisabled()
    expect(screen.getByRole('slider', { name: 'Match length' })).toBeEnabled()
  })
})
