import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { FilterChips } from './FilterChips'
import { ToastProvider } from './ToastProvider'

function renderChips() {
  const onChange = vi.fn()
  render(
    <ToastProvider>
      <FilterChips
        label="Filter by event"
        allLabel="All events"
        options={['Open singles', 'Under 18', 'Doubles']}
        onChange={onChange}
      />
    </ToastProvider>,
  )
  return onChange
}

const chip = (name: string) => screen.getByRole('button', { name })

// The chips that are on, in order.
const pressed = () =>
  screen
    .getAllByRole('button', { pressed: true })
    .map((button) => button.textContent)

describe('FilterChips', () => {
  it('starts with All events on', () => {
    renderChips()

    expect(pressed()).toEqual(['All events'])
  })

  it('turns on several events together, and All events off', async () => {
    const user = userEvent.setup()
    const onChange = renderChips()

    await user.click(chip('Doubles'))
    await user.click(chip('Open singles'))

    expect(pressed()).toEqual(['Open singles', 'Doubles'])
    expect(onChange).toHaveBeenLastCalledWith(['Open singles', 'Doubles'])
    expect(await screen.findByText('Showing Open singles, Doubles')).toBeInTheDocument()
  })

  it('turns All events back on when the last event goes off', async () => {
    const user = userEvent.setup()
    const onChange = renderChips()

    await user.click(chip('Under 18'))
    await user.click(chip('Under 18'))

    expect(pressed()).toEqual(['All events'])
    expect(onChange).toHaveBeenLastCalledWith(['All events'])
    expect(await screen.findByText('Showing All events')).toBeInTheDocument()
  })

  it('turns every event off with All events', async () => {
    const user = userEvent.setup()
    renderChips()
    await user.click(chip('Under 18'))
    await user.click(chip('Doubles'))

    await user.click(chip('All events'))

    expect(pressed()).toEqual(['All events'])
  })

  it('keeps All events on when it is clicked again', async () => {
    const user = userEvent.setup()
    renderChips()

    await user.click(chip('All events'))

    expect(pressed()).toEqual(['All events'])
  })

  it('is a tab stop per chip, toggled with Space or Enter, and the arrows do nothing', async () => {
    const user = userEvent.setup()
    renderChips()

    await user.tab()
    await user.tab()
    expect(chip('Open singles')).toHaveFocus()
    await user.keyboard(' ')
    expect(pressed()).toEqual(['Open singles'])
    await user.keyboard('{ArrowRight}')
    expect(chip('Open singles')).toHaveFocus()
    await user.tab()
    await user.keyboard('{Enter}')
    expect(pressed()).toEqual(['Open singles', 'Under 18'])
  })
})
