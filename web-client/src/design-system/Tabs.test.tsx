import { render, screen } from '@testing-library/react'
import { describe, expect } from 'vitest'
import { it } from '../setupTests.ts'
import { Tabs } from './Tabs.tsx'

const sections = [
  { id: 'overview', label: 'Overview' },
  { id: 'schedule', label: 'Schedule' },
]

function TournamentTabs() {
  return (
    <Tabs aria-label="Tournament sections" tabs={sections} defaultSelectedId="overview">
      {(id) => <p>{id === 'overview' ? '32 players' : 'Round of 16 at 11:00'}</p>}
    </Tabs>
  )
}

describe('Tabs', () => {
  it('is a tab list named by its label', () => {
    render(<TournamentTabs />)
    expect(screen.getByRole('tablist', { name: 'Tournament sections' })).toBeInTheDocument()
  })

  it('selects its default tab', () => {
    render(<TournamentTabs />)
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true')
  })

  it('shows the selected tab’s content, named by the tab', () => {
    render(<TournamentTabs />)
    expect(screen.getByRole('tabpanel', { name: 'Overview' })).toHaveTextContent('32 players')
  })

  it('shows another tab’s content when it is clicked', async ({ user }) => {
    render(<TournamentTabs />)
    await user.click(screen.getByRole('tab', { name: 'Schedule' }))
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Round of 16 at 11:00')
  })

  it('moves between tabs with the arrow keys', async ({ user }) => {
    render(<TournamentTabs />)
    await user.click(screen.getByRole('tab', { name: 'Overview' }))
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: 'Schedule' })).toHaveAttribute('aria-selected', 'true')
  })
})
