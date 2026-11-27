import { render, screen } from '@testing-library/react'
import { describe, expect, vi } from 'vitest'
import { it } from '../setupTests.ts'
import { FilterChips } from './FilterChips.tsx'

const events = [
  { id: 'open', label: 'Open singles' },
  { id: 'u18', label: 'Under 18' },
]

function chip(name: string) {
  return screen.getByRole('button', { name })
}

describe('FilterChips', () => {
  it('is a toolbar named by its label', () => {
    render(<FilterChips aria-label="Filter by event" allLabel="All events" options={events} />)
    expect(screen.getByRole('toolbar', { name: 'Filter by event' })).toBeInTheDocument()
  })

  it('has the all chip on when no option is', () => {
    render(<FilterChips aria-label="Filter by event" allLabel="All events" options={events} />)
    expect(chip('All events')).toHaveAttribute('aria-pressed', 'true')
  })

  it('has the all chip off when an option is on', () => {
    render(
      <FilterChips
        aria-label="Filter by event"
        allLabel="All events"
        options={events}
        defaultSelectedIds={['open']}
      />,
    )
    expect(chip('All events')).toHaveAttribute('aria-pressed', 'false')
  })

  it('lets several options be on together', async ({ user }) => {
    const onChange = vi.fn()
    render(
      <FilterChips
        aria-label="Filter by event"
        allLabel="All events"
        options={events}
        defaultSelectedIds={['open']}
        onChange={onChange}
      />,
    )
    await user.click(chip('Under 18'))
    expect(onChange).toHaveBeenLastCalledWith(['open', 'u18'])
  })

  it('clears the options when the all chip is clicked', async ({ user }) => {
    render(
      <FilterChips
        aria-label="Filter by event"
        allLabel="All events"
        options={events}
        defaultSelectedIds={['open', 'u18']}
      />,
    )
    await user.click(chip('All events'))
    expect(chip('Open singles')).toHaveAttribute('aria-pressed', 'false')
  })

  it('switches the all chip back on when the last option goes off', async ({ user }) => {
    render(
      <FilterChips
        aria-label="Filter by event"
        allLabel="All events"
        options={events}
        defaultSelectedIds={['open']}
      />,
    )
    await user.click(chip('Open singles'))
    expect(chip('All events')).toHaveAttribute('aria-pressed', 'true')
  })

  it('keeps the all chip on when it is clicked with nothing to clear', async ({ user }) => {
    render(<FilterChips aria-label="Filter by event" allLabel="All events" options={events} />)
    await user.click(chip('All events'))
    expect(chip('All events')).toHaveAttribute('aria-pressed', 'true')
  })
})
