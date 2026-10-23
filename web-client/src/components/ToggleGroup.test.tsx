import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState, type ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Field, FieldHelp, Label } from './Field'
import { ToggleGroup, ToggleGroupItem } from './ToggleGroup'

function MatchTypes(
  props: Omit<ComponentProps<typeof ToggleGroup>, 'children'>,
) {
  return (
    <ToggleGroup aria-label="Match type" {...props}>
      <ToggleGroupItem value="singles">Singles</ToggleGroupItem>
      <ToggleGroupItem value="doubles">Doubles</ToggleGroupItem>
      <ToggleGroupItem value="mixed">Mixed</ToggleGroupItem>
    </ToggleGroup>
  )
}

function items() {
  return {
    singles: screen.getByRole('radio', { name: 'Singles' }),
    doubles: screen.getByRole('radio', { name: 'Doubles' }),
    mixed: screen.getByRole('radio', { name: 'Mixed' }),
  }
}

function checked() {
  return screen
    .getAllByRole('radio')
    .map((item) => item.getAttribute('aria-checked'))
}

function tabIndexes() {
  return screen.getAllByRole('radio').map((item) => item.tabIndex)
}

describe('ToggleGroup', () => {
  it('renders a named group of radio buttons outside a Field', () => {
    render(<MatchTypes defaultValue="singles" />)

    const group = screen.getByRole('radiogroup', { name: 'Match type' })
    expect(group).toHaveClass('toggle-group')
    expect(group).not.toHaveAttribute('aria-labelledby')
    expect(group).not.toHaveAttribute('aria-describedby')
    for (const item of Object.values(items())) {
      expect(item.tagName).toBe('BUTTON')
      expect(item).toHaveAttribute('type', 'button')
      expect(item).toHaveClass('toggle')
      expect(item).not.toHaveAttribute('aria-pressed')
      expect(item).toBeEnabled()
    }
    expect(checked()).toEqual(['true', 'false', 'false'])
  })

  it('chooses an item when it is clicked', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(<MatchTypes defaultValue="singles" onValueChange={onValueChange} />)

    await user.click(items().doubles)
    expect(checked()).toEqual(['false', 'true', 'false'])
    expect(tabIndexes()).toEqual([-1, 0, -1])

    await user.click(items().mixed)
    expect(checked()).toEqual(['false', 'false', 'true'])
    expect(onValueChange.mock.calls).toEqual([['doubles'], ['mixed']])
  })

  it('keeps the chosen item when it is pressed again', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(<MatchTypes defaultValue="singles" onValueChange={onValueChange} />)
    const { singles } = items()

    await user.click(singles)
    await user.keyboard(' ')
    await user.keyboard('{Enter}')
    expect(checked()).toEqual(['true', 'false', 'false'])
    // The value didn't change, so there's nothing to tell.
    expect(onValueChange).not.toHaveBeenCalled()
  })

  it('moves the focus and the choice with the arrow keys, wrapping', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(<MatchTypes defaultValue="singles" onValueChange={onValueChange} />)
    const { singles, doubles, mixed } = items()

    await user.tab()
    expect(singles).toHaveFocus()
    await user.keyboard('{ArrowRight}')
    expect(doubles).toHaveFocus()
    expect(checked()).toEqual(['false', 'true', 'false'])
    await user.keyboard('{ArrowDown}')
    expect(mixed).toHaveFocus()
    await user.keyboard('{ArrowRight}')
    expect(singles).toHaveFocus()
    expect(checked()).toEqual(['true', 'false', 'false'])
    await user.keyboard('{ArrowLeft}')
    expect(mixed).toHaveFocus()
    await user.keyboard('{ArrowUp}')
    expect(doubles).toHaveFocus()
    expect(checked()).toEqual(['false', 'true', 'false'])
    expect(onValueChange.mock.calls).toEqual([
      ['doubles'],
      ['mixed'],
      ['singles'],
      ['mixed'],
      ['doubles'],
    ])
  })

  it('cancels the arrow keys, so they move nothing else', async () => {
    render(<MatchTypes defaultValue="singles" />)
    const { singles } = items()
    singles.focus()

    for (const key of ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp']) {
      const event = new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
      })
      singles.dispatchEvent(event)
      expect(event.defaultPrevented, key).toBe(true)
    }
  })

  it('leaves an arrow with Alt, Ctrl or Meta to the browser', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(<MatchTypes defaultValue="singles" onValueChange={onValueChange} />)
    const { singles } = items()

    await user.tab()
    await user.keyboard('{Alt>}{ArrowRight}{/Alt}')
    await user.keyboard('{Control>}{ArrowRight}{/Control}')
    await user.keyboard('{Meta>}{ArrowLeft}{/Meta}')
    expect(singles).toHaveFocus()
    expect(checked()).toEqual(['true', 'false', 'false'])
    expect(onValueChange).not.toHaveBeenCalled()
  })

  it('skips disabled items with the arrow keys', async () => {
    const user = userEvent.setup()
    render(
      <ToggleGroup aria-label="Match type" defaultValue="singles">
        <ToggleGroupItem value="singles">Singles</ToggleGroupItem>
        <ToggleGroupItem value="doubles" disabled>
          Doubles
        </ToggleGroupItem>
        <ToggleGroupItem value="mixed">Mixed</ToggleGroupItem>
      </ToggleGroup>,
    )
    const { singles, mixed } = items()

    await user.tab()
    await user.keyboard('{ArrowRight}')
    expect(mixed).toHaveFocus()
    expect(checked()).toEqual(['false', 'false', 'true'])
    await user.keyboard('{ArrowLeft}')
    expect(singles).toHaveFocus()
    expect(checked()).toEqual(['true', 'false', 'false'])
  })

  it('chooses the focused item with Space or Enter', async () => {
    const user = userEvent.setup()
    render(<MatchTypes />)
    const { singles, doubles } = items()

    await user.tab()
    expect(singles).toHaveFocus()
    await user.keyboard(' ')
    expect(checked()).toEqual(['true', 'false', 'false'])

    doubles.focus()
    await user.keyboard('{Enter}')
    expect(checked()).toEqual(['false', 'true', 'false'])
  })

  it('is one Tab stop, on the chosen item', async () => {
    const user = userEvent.setup()
    render(
      <>
        <MatchTypes defaultValue="doubles" />
        <button type="button">After</button>
      </>,
    )

    expect(tabIndexes()).toEqual([-1, 0, -1])
    await user.tab()
    expect(items().doubles).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus()
  })

  it('is one Tab stop, on the first enabled item, with none chosen', async () => {
    const user = userEvent.setup()
    render(
      <ToggleGroup aria-label="Match type">
        <ToggleGroupItem value="singles" disabled>
          Singles
        </ToggleGroupItem>
        <ToggleGroupItem value="doubles">Doubles</ToggleGroupItem>
        <ToggleGroupItem value="mixed">Mixed</ToggleGroupItem>
      </ToggleGroup>,
    )

    expect(checked()).toEqual(['false', 'false', 'false'])
    expect(tabIndexes()).toEqual([-1, 0, -1])
    await user.tab()
    expect(items().doubles).toHaveFocus()
  })

  it('never has two items chosen', async () => {
    const user = userEvent.setup()
    render(<MatchTypes defaultValue="singles" />)

    for (const name of ['Doubles', 'Mixed', 'Singles', 'Mixed']) {
      await user.click(screen.getByRole('radio', { name }))
      expect(
        screen.getAllByRole('radio', { checked: true }).map((item) => item.textContent),
      ).toEqual([name])
    }
  })

  it('can be controlled', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    function Controlled() {
      const [value, setValue] = useState('singles')
      return (
        <MatchTypes
          value={value}
          onValueChange={(next) => {
            onValueChange(next)
            setValue(next)
          }}
        />
      )
    }
    render(<Controlled />)

    await user.click(items().mixed)
    expect(onValueChange).toHaveBeenLastCalledWith('mixed')
    expect(checked()).toEqual(['false', 'false', 'true'])
  })

  it('stays as its value prop says when onValueChange ignores the click', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(<MatchTypes value="singles" onValueChange={onValueChange} />)

    await user.click(items().doubles)
    expect(onValueChange).toHaveBeenCalledWith('doubles')
    expect(checked()).toEqual(['true', 'false', 'false'])
  })

  it('ignores clicks when the group is disabled', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(
      <MatchTypes
        disabled
        defaultValue="singles"
        onValueChange={onValueChange}
      />,
    )
    const { doubles } = items()
    for (const item of Object.values(items())) expect(item).toBeDisabled()

    await user.click(doubles)
    expect(checked()).toEqual(['true', 'false', 'false'])
    expect(onValueChange).not.toHaveBeenCalled()
  })

  it('ignores clicks on a disabled item', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(
      <ToggleGroup aria-label="Match type" onValueChange={onValueChange}>
        <ToggleGroupItem value="singles">Singles</ToggleGroupItem>
        <ToggleGroupItem value="doubles" disabled>
          Doubles
        </ToggleGroupItem>
      </ToggleGroup>,
    )
    const { singles, doubles } = {
      singles: screen.getByRole('radio', { name: 'Singles' }),
      doubles: screen.getByRole('radio', { name: 'Doubles' }),
    }
    expect(doubles).toBeDisabled()

    await user.click(doubles)
    expect(doubles).toHaveAttribute('aria-checked', 'false')
    expect(onValueChange).not.toHaveBeenCalled()

    await user.click(singles)
    expect(singles).toHaveAttribute('aria-checked', 'true')
  })

  it('lets an item enable itself in a disabled group', () => {
    render(
      <ToggleGroup aria-label="Match type" disabled>
        <ToggleGroupItem value="singles" disabled={false}>
          Singles
        </ToggleGroupItem>
        <ToggleGroupItem value="doubles">Doubles</ToggleGroupItem>
      </ToggleGroup>,
    )

    expect(screen.getByRole('radio', { name: 'Singles' })).toBeEnabled()
    expect(screen.getByRole('radio', { name: 'Doubles' })).toBeDisabled()
  })

  it('needs a ToggleGroup around its items', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() =>
      render(<ToggleGroupItem value="a">A</ToggleGroupItem>),
    ).toThrow('A ToggleGroupItem must be inside a ToggleGroup.')
    vi.restoreAllMocks()
  })

  it("is named by a Field's Label and described by its help text", () => {
    render(
      <Field>
        <Label>Match type</Label>
        <MatchTypes aria-label={undefined} />
        <FieldHelp>Pick who plays.</FieldHelp>
      </Field>,
    )

    const group = screen.getByRole('radiogroup', { name: 'Match type' })
    expect(group).toHaveAccessibleDescription('Pick who plays.')
    for (const item of Object.values(items())) {
      expect(item).toBeEnabled()
      expect(item).not.toHaveAttribute('aria-describedby')
    }
  })

  it('is disabled by a disabled Field unless it says otherwise', () => {
    render(
      <>
        <Field disabled>
          <Label>Match type</Label>
          <ToggleGroup>
            <ToggleGroupItem value="singles">Singles</ToggleGroupItem>
          </ToggleGroup>
        </Field>
        <Field disabled>
          <Label>Side</Label>
          <ToggleGroup disabled={false}>
            <ToggleGroupItem value="left">Left</ToggleGroupItem>
          </ToggleGroup>
        </Field>
      </>,
    )

    expect(screen.getByRole('radio', { name: 'Singles' })).toBeDisabled()
    expect(screen.getByRole('radio', { name: 'Left' })).toBeEnabled()
  })
})
