import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { Tabs } from './Tabs'
import { ToastProvider } from './ToastProvider'

function renderTabs({ lazy = false }: { lazy?: boolean } = {}) {
  render(
    <ToastProvider>
      <button type="button">Before</button>
      <Tabs
        label="Tournament sections"
        lazy={lazy}
        tabs={[
          { label: 'Overview', panel: <p>32 players</p> },
          { label: 'Schedule', panel: <p>14 of 31 matches played.</p> },
          { label: 'Standings', panel: <p>Groups A–D</p> },
        ]}
      />
      <button type="button">After</button>
    </ToastProvider>,
  )
}

const tab = (name: string) => screen.getByRole('tab', { name })
// The one panel that shows.
const panel = () => screen.getByRole('tabpanel')

// Checks that the tab `name` is the selected one and its panel is the one
// that shows.
function expectSelected(name: string) {
  for (const other of ['Overview', 'Schedule', 'Standings']) {
    expect(tab(other)).toHaveAttribute('aria-selected', String(other === name))
  }
  expect(panel()).toHaveAccessibleName(name)
}

describe('Tabs', () => {
  it('renders only the selected panel’s content when lazy', async () => {
    const user = userEvent.setup()
    renderTabs({ lazy: true })
    expect(screen.queryByText('Groups A–D')).toBeNull()

    await user.click(tab('Standings'))
    expect(panel()).toHaveTextContent('Groups A–D')
    expect(screen.queryByText('32 players')).toBeNull()
  })

  it('starts on the first tab and shows only its panel', () => {
    renderTabs()

    expect(screen.getByRole('tablist', { name: 'Tournament sections' })).toBeInTheDocument()
    expectSelected('Overview')
  })

  it('shows the panel of a clicked tab', async () => {
    const user = userEvent.setup()
    renderTabs()

    await user.click(tab('Standings'))

    expectSelected('Standings')
    expect(panel()).toHaveTextContent('Groups A–D')
  })

  it('is one tab stop, on the selected tab', async () => {
    const user = userEvent.setup()
    renderTabs()
    await user.click(tab('Schedule'))
    screen.getByRole('button', { name: 'Before' }).focus()

    await user.tab()
    expect(tab('Schedule')).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus()
  })

  it('moves the selection and focus with the arrow keys, wrapping at the ends', async () => {
    const user = userEvent.setup()
    renderTabs()
    tab('Overview').focus()

    await user.keyboard('{ArrowRight}')
    expectSelected('Schedule')
    expect(tab('Schedule')).toHaveFocus()
    await user.keyboard('{ArrowDown}{ArrowDown}')
    expectSelected('Overview')
    await user.keyboard('{ArrowLeft}')
    expectSelected('Standings')
    expect(tab('Standings')).toHaveFocus()
    await user.keyboard('{ArrowUp}')
    expectSelected('Schedule')
  })

  it('goes to the first and last tab with Home and End', async () => {
    const user = userEvent.setup()
    renderTabs()
    tab('Overview').focus()

    await user.keyboard('{End}')
    expectSelected('Standings')
    expect(tab('Standings')).toHaveFocus()
    await user.keyboard('{Home}')
    expectSelected('Overview')
    expect(tab('Overview')).toHaveFocus()
  })
})
