import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { Tabs } from './Tabs'

const tabs = [
  { value: 'overview', label: 'Overview', panel: 'The overview.' },
  { value: 'schedule', label: 'Schedule', panel: 'The schedule.' },
  { value: 'standings', label: 'Standings', panel: 'The standings.' },
]

function selected() {
  return screen
    .getAllByRole('tab')
    .map((tab) => tab.getAttribute('aria-selected'))
}

function tabIndexes() {
  return screen.getAllByRole('tab').map((tab) => tab.tabIndex)
}

describe('Tabs', () => {
  it('renders a named tablist of tab buttons', () => {
    render(<Tabs label="Tournament" tabs={tabs} />)

    expect(screen.getByRole('tablist', { name: 'Tournament' })).toHaveClass(
      'tabs-list',
    )
    const buttons = screen.getAllByRole('tab')
    expect(buttons.map((tab) => tab.textContent)).toEqual([
      'Overview',
      'Schedule',
      'Standings',
    ])
    for (const tab of buttons) {
      expect(tab.tagName).toBe('BUTTON')
      expect(tab).toHaveAttribute('type', 'button')
      expect(tab).toHaveClass('tab')
    }
  })

  it('chooses the first tab unless given one', () => {
    render(<Tabs label="Tournament" tabs={tabs} />)

    expect(selected()).toEqual(['true', 'false', 'false'])
    expect(tabIndexes()).toEqual([0, -1, -1])
  })

  it("shows only the chosen tab's panel, labelled by its tab", () => {
    render(<Tabs label="Tournament" tabs={tabs} defaultValue="schedule" />)

    const panel = screen.getByRole('tabpanel')
    expect(panel).toHaveTextContent('The schedule.')
    expect(panel).toHaveAccessibleName('Schedule')
    expect(panel).toHaveClass('tab-content')
    expect(screen.getByRole('tab', { name: 'Schedule' })).toHaveAttribute(
      'aria-controls',
      panel.id,
    )
    expect(screen.queryByText('The overview.')).not.toBeVisible()
  })

  it('chooses a tab when it is clicked', async () => {
    const user = userEvent.setup()
    render(<Tabs label="Tournament" tabs={tabs} />)

    await user.click(screen.getByRole('tab', { name: 'Standings' }))

    expect(selected()).toEqual(['false', 'false', 'true'])
    expect(tabIndexes()).toEqual([-1, -1, 0])
    expect(screen.getByRole('tabpanel')).toHaveTextContent('The standings.')
  })

  it('moves the focus and the choice with the arrow keys, wrapping', async () => {
    const user = userEvent.setup()
    render(<Tabs label="Tournament" tabs={tabs} />)
    await user.tab()

    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: 'Schedule' })).toHaveFocus()
    expect(selected()).toEqual(['false', 'true', 'false'])

    await user.keyboard('{ArrowLeft}{ArrowLeft}')
    expect(screen.getByRole('tab', { name: 'Standings' })).toHaveFocus()
    expect(selected()).toEqual(['false', 'false', 'true'])

    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveFocus()
    expect(screen.getByRole('tabpanel')).toHaveTextContent('The overview.')
  })

  it('moves to the first and last tab with Home and End', async () => {
    const user = userEvent.setup()
    render(<Tabs label="Tournament" tabs={tabs} />)
    await user.tab()

    await user.keyboard('{End}')
    expect(screen.getByRole('tab', { name: 'Standings' })).toHaveFocus()
    expect(selected()).toEqual(['false', 'false', 'true'])

    await user.keyboard('{Home}')
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveFocus()
    expect(selected()).toEqual(['true', 'false', 'false'])
  })

  it('is one Tab stop, then the panel', async () => {
    const user = userEvent.setup()
    render(<Tabs label="Tournament" tabs={tabs} defaultValue="schedule" />)

    await user.tab()
    expect(screen.getByRole('tab', { name: 'Schedule' })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('tabpanel')).toHaveFocus()
  })
})
