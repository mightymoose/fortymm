import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Combobox, type ComboboxOption } from './Combobox'
import { Field, FieldHelp, Label } from './Field'

const players: ComboboxOption[] = [
  { id: 'tien', label: 'Nguyen, Tien', hint: '1620' },
  { id: 'mai', label: 'Nguyen, Mai', hint: '1455' },
  { id: 'phuc', label: 'Nguyen, Phuc', hint: '1380' },
  { id: 'ana', label: 'Silva, Ana', hint: '1710' },
]

// The listbox, found even while it's hidden.
function listbox(): HTMLElement {
  return screen.getByRole('listbox', { hidden: true })
}

// The shown options' text, in order.
function optionTexts(): (string | null)[] {
  return screen.queryAllByRole('option').map((option) => option.textContent)
}

// The option the combobox points at as active, which must be the only one
// marked selected.
function activeOption(): HTMLElement | null {
  const id = screen.getByRole('combobox').getAttribute('aria-activedescendant')
  const selected = screen
    .queryAllByRole('option')
    .filter((option) => option.getAttribute('aria-selected') === 'true')
  expect(selected.map((option) => option.id)).toEqual(id ? [id] : [])
  return id ? document.getElementById(id) : null
}

describe('Combobox', () => {
  it('renders closed by default', () => {
    render(<Combobox aria-label="Find a player" options={players} />)

    const combobox = screen.getByRole('combobox', { name: 'Find a player' })
    expect(combobox).toHaveValue('')
    expect(combobox).toHaveAttribute('aria-expanded', 'false')
    expect(combobox).toHaveAttribute('aria-controls', listbox().id)
    expect(combobox).not.toHaveAttribute('aria-activedescendant')
    expect(listbox()).not.toBeVisible()
    expect(screen.queryAllByRole('option')).toEqual([])
  })

  it('shows the options whose label holds the query, ignoring case', async () => {
    const user = userEvent.setup()
    render(<Combobox aria-label="Find a player" options={players} />)
    const combobox = screen.getByRole('combobox')

    await user.type(combobox, 'NGU')

    expect(combobox).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('listbox', { name: 'Find a player' })).toBeVisible()
    expect(optionTexts()).toEqual([
      'Nguyen, Tien 1620',
      'Nguyen, Mai 1455',
      'Nguyen, Phuc 1380',
    ])

    await user.clear(combobox)
    await user.type(combobox, 'ana')
    expect(optionTexts()).toEqual(['Silva, Ana 1710'])
  })

  it('hides the list when nothing matches, and never matches a hint', async () => {
    const user = userEvent.setup()
    render(<Combobox aria-label="Find a player" options={players} />)
    const combobox = screen.getByRole('combobox')

    await user.type(combobox, '16')

    expect(combobox).toHaveAttribute('aria-expanded', 'false')
    expect(combobox).not.toHaveAttribute('aria-activedescendant')
    expect(listbox()).not.toBeVisible()
    expect(screen.queryAllByRole('option')).toEqual([])
  })

  it('makes the first match active as the user types', async () => {
    const user = userEvent.setup()
    render(<Combobox aria-label="Find a player" options={players} />)

    await user.type(screen.getByRole('combobox'), 'ngu')
    expect(activeOption()).toHaveTextContent('Nguyen, Tien')

    await user.type(screen.getByRole('combobox'), 'yen, m')
    expect(activeOption()).toHaveTextContent('Nguyen, Mai')
  })

  it('moves the active option with the arrow keys, wrapping at the ends', async () => {
    const user = userEvent.setup()
    render(<Combobox aria-label="Find a player" options={players} />)
    await user.type(screen.getByRole('combobox'), 'ngu')

    await user.keyboard('{ArrowDown}')
    expect(activeOption()).toHaveTextContent('Nguyen, Mai')
    await user.keyboard('{ArrowDown}')
    expect(activeOption()).toHaveTextContent('Nguyen, Phuc')
    await user.keyboard('{ArrowDown}')
    expect(activeOption()).toHaveTextContent('Nguyen, Tien')
    await user.keyboard('{ArrowUp}')
    expect(activeOption()).toHaveTextContent('Nguyen, Phuc')
  })

  it('opens a closed list with the arrow keys', async () => {
    const user = userEvent.setup()
    render(<Combobox aria-label="Find a player" options={players} />)
    const combobox = screen.getByRole('combobox')
    await user.click(combobox)

    await user.keyboard('{ArrowDown}')
    expect(combobox).toHaveAttribute('aria-expanded', 'true')
    expect(activeOption()).toHaveTextContent('Nguyen, Tien')

    await user.keyboard('{Escape}{ArrowUp}')
    expect(combobox).toHaveAttribute('aria-expanded', 'true')
    expect(activeOption()).toHaveTextContent('Silva, Ana')
  })

  it('makes the option under the pointer active', async () => {
    const user = userEvent.setup()
    render(<Combobox aria-label="Find a player" options={players} />)
    await user.type(screen.getByRole('combobox'), 'ngu')

    await user.hover(screen.getByRole('option', { name: 'Nguyen, Phuc 1380' }))

    expect(activeOption()).toHaveTextContent('Nguyen, Phuc')
  })

  it('chooses the active option on Enter', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(
      <Combobox
        aria-label="Find a player"
        options={players}
        onValueChange={onValueChange}
      />,
    )
    const combobox = screen.getByRole('combobox')
    await user.type(combobox, 'ngu{ArrowDown}')

    await user.keyboard('{Enter}')

    expect(combobox).toHaveValue('Nguyen, Mai')
    expect(combobox).toHaveAttribute('aria-expanded', 'false')
    expect(listbox()).not.toBeVisible()
    expect(onValueChange).toHaveBeenCalledOnce()
    expect(onValueChange).toHaveBeenCalledWith(players[1])
  })

  it("leaves Enter to the form when there's no active option", async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    const onValueChange = vi.fn()
    render(
      <form
        onSubmit={(event) => {
          event.preventDefault()
          onSubmit()
        }}
      >
        <Combobox
          aria-label="Find a player"
          options={players}
          onValueChange={onValueChange}
        />
      </form>,
    )
    const combobox = screen.getByRole('combobox')

    await user.type(combobox, 'zzz{Enter}')
    expect(onSubmit).toHaveBeenCalledOnce()
    expect(onValueChange).not.toHaveBeenCalled()

    await user.clear(combobox)
    await user.type(combobox, 'ngu{Enter}')
    expect(onSubmit).toHaveBeenCalledOnce()
    expect(onValueChange).toHaveBeenCalledOnce()
  })

  it('chooses an option on a click, keeping the focus in the input', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(
      <Combobox
        aria-label="Find a player"
        options={players}
        onValueChange={onValueChange}
      />,
    )
    const combobox = screen.getByRole('combobox')
    await user.type(combobox, 'ngu')

    await user.click(screen.getByRole('option', { name: 'Nguyen, Phuc 1380' }))

    expect(combobox).toHaveValue('Nguyen, Phuc')
    expect(combobox).toHaveFocus()
    expect(combobox).toHaveAttribute('aria-expanded', 'false')
    expect(onValueChange).toHaveBeenCalledWith(players[2])
  })

  it('closes on Escape, keeping the query', async () => {
    const user = userEvent.setup()
    render(<Combobox aria-label="Find a player" options={players} />)
    const combobox = screen.getByRole('combobox')
    await user.type(combobox, 'ngu')

    await user.keyboard('{Escape}')

    expect(combobox).toHaveValue('ngu')
    expect(combobox).toHaveAttribute('aria-expanded', 'false')
    expect(combobox).not.toHaveAttribute('aria-activedescendant')
    expect(listbox()).not.toBeVisible()
  })

  it('closes when the focus leaves it', async () => {
    const user = userEvent.setup()
    render(
      <>
        <Combobox aria-label="Find a player" options={players} />
        <button type="button">Next</button>
      </>,
    )
    const combobox = screen.getByRole('combobox')
    await user.type(combobox, 'ngu')

    await user.tab()

    expect(screen.getByRole('button', { name: 'Next' })).toHaveFocus()
    expect(combobox).toHaveAttribute('aria-expanded', 'false')
    expect(listbox()).not.toBeVisible()
  })

  it('ignores typing and keys when disabled', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(
      <Combobox
        aria-label="Find a player"
        options={players}
        defaultQuery="ngu"
        defaultOpen
        disabled
        onValueChange={onValueChange}
      />,
    )
    const combobox = screen.getByRole('combobox', { name: 'Find a player' })
    expect(combobox).toBeDisabled()
    expect(combobox).toHaveAttribute('aria-expanded', 'false')
    expect(listbox()).not.toBeVisible()

    await user.type(combobox, 'x{ArrowDown}{Enter}')

    expect(combobox).toHaveValue('ngu')
    expect(combobox).not.toHaveFocus()
    expect(combobox).toHaveAttribute('aria-expanded', 'false')
    expect(onValueChange).not.toHaveBeenCalled()
  })

  it('opens on its default query with the first match active', () => {
    render(
      <Combobox
        aria-label="Find a player"
        options={players}
        defaultQuery="ngu"
        defaultOpen
      />,
    )

    const combobox = screen.getByRole('combobox')
    expect(combobox).toHaveValue('ngu')
    expect(combobox).toHaveAttribute('aria-expanded', 'true')
    expect(optionTexts()).toEqual([
      'Nguyen, Tien 1620',
      'Nguyen, Mai 1455',
      'Nguyen, Phuc 1380',
    ])
    expect(activeOption()).toHaveTextContent('Nguyen, Tien')
  })

  it('adds its className to the cmd class on its box', () => {
    render(
      <Combobox
        aria-label="Find a player"
        options={players}
        className="combobox-demo"
      />,
    )

    expect(listbox().parentElement).toHaveAttribute(
      'class',
      'cmd combobox-demo',
    )
    expect(screen.getByRole('combobox')).not.toHaveAttribute('class')
  })

  it('passes its props to the input', () => {
    render(
      <Combobox
        aria-label="Find a player"
        options={players}
        name="player"
        placeholder="Find a player…"
        aria-describedby="player-help"
        aria-invalid
        required
      />,
    )

    const combobox = screen.getByRole('combobox', { name: 'Find a player' })
    expect(combobox).toHaveAttribute('name', 'player')
    expect(combobox).toHaveAttribute('placeholder', 'Find a player…')
    expect(combobox).toHaveAttribute('aria-describedby', 'player-help')
    expect(combobox).toHaveAttribute('autocomplete', 'off')
    expect(combobox).toBeInvalid()
    expect(combobox).toBeRequired()
  })

  it("takes a Field's label, help text and invalid state", async () => {
    const user = userEvent.setup()
    render(
      <Field invalid>
        <Label>Opponent</Label>
        <Combobox options={players} />
        <FieldHelp>Pick a player you've played.</FieldHelp>
      </Field>,
    )

    const combobox = screen.getByRole('combobox', { name: 'Opponent' })
    expect(combobox).toHaveAccessibleDescription("Pick a player you've played.")
    expect(combobox).toBeInvalid()
    expect(combobox).toHaveAttribute('aria-invalid', 'true')

    await user.type(combobox, 'ngu')
    expect(screen.getByRole('listbox', { name: 'Opponent' })).toBeVisible()
  })

  it('is required in a required Field', () => {
    render(
      <Field required>
        <Label>Opponent</Label>
        <Combobox options={players} />
      </Field>,
    )

    const combobox = screen.getByRole<HTMLInputElement>('combobox', {
      name: 'Opponent',
    })
    expect(combobox).toBeRequired()
    expect(combobox.validity.valueMissing).toBe(true)
  })

  it('is disabled by a disabled Field unless it says otherwise', () => {
    render(
      <>
        <Field disabled>
          <Label>Opponent</Label>
          <Combobox options={players} defaultQuery="ngu" defaultOpen />
        </Field>
        <Field disabled>
          <Label>Partner</Label>
          <Combobox
            options={players}
            defaultQuery="ngu"
            defaultOpen
            disabled={false}
          />
        </Field>
      </>,
    )

    const opponent = screen.getByRole('combobox', { name: 'Opponent' })
    expect(opponent).toBeDisabled()
    expect(opponent).toHaveAttribute('aria-expanded', 'false')
    const partner = screen.getByRole('combobox', { name: 'Partner' })
    expect(partner).toBeEnabled()
    expect(partner).toHaveAttribute('aria-expanded', 'true')
  })
})
