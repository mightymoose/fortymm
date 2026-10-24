import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../../components/ToastProvider'
import { TooltipProvider } from '../../components/TooltipProvider'
import { day } from './match'
import { Timeline } from './Timeline'

function renderTimeline() {
  const onSelect = vi.fn()
  render(
    <ToastProvider>
      <TooltipProvider>
        <Timeline day={day} initial="b3" onSelect={onSelect} />
      </TooltipProvider>
    </ToastProvider>,
  )
  return onSelect
}

const block = (name: string) => screen.getByRole('button', { name: new RegExp(name) })

describe('Timeline', () => {
  it('has a track of blocks per table, each named by its match in full', () => {
    renderTimeline()

    const table2 = screen.getByRole('group', { name: 'Table 2' })
    expect(within(table2).getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Final 3–0LindqvistHaddad10:30–11:00Lindqvist, Erik vs Haddad, Youssef · Table 2 · 10:30–11:00',
      'Needs decisionPatelPark11:50–12:25Patel, Meera vs Park, Ji-ho · Table 2 · 11:50–12:25 · Patel would rest 5 min',
    ])
    expect(table2).toHaveTextContent('Free11:05–11:45')
  })

  it('starts with its initial match pressed', () => {
    renderTimeline()

    const pressed = screen.getAllByRole('button', { pressed: true })
    expect(pressed).toEqual([block('Patel, Meera vs Park, Ji-ho')])
  })

  it('presses a clicked block, says so, and passes its match on', async () => {
    const user = userEvent.setup()
    const onSelect = renderTimeline()

    await user.click(block('Dubois, Camille vs Lindqvist, Erik'))

    expect(block('Dubois, Camille vs Lindqvist, Erik')).toHaveAttribute('aria-pressed', 'true')
    expect(block('Patel, Meera vs Park, Ji-ho')).toHaveAttribute('aria-pressed', 'false')
    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'c3' }))
    expect(await screen.findByText('Dubois vs Lindqvist, selected')).toBeInTheDocument()
  })

  it('shows the rest and the time now', () => {
    renderTimeline()

    expect(block('Dubois, Camille vs Lindqvist, Erik')).toHaveTextContent(
      /^Lindqvist rests to 12:10/,
    )
    expect(block('Okafor-Adeyemi, Daniel')).toHaveTextContent(/since 11:10/)
    expect(screen.getByText('Now 11:47')).toBeInTheDocument()
  })
})
