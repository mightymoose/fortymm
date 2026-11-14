import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { Tabs, type Tab } from './Tabs.tsx'

const tabs: Tab[] = [
  { value: 'schedule', label: 'Schedule', panel: <p>Today’s matches</p> },
  { value: 'draw', label: 'Draw', panel: <p>The bracket</p> },
  { value: 'players', label: 'Players', disabled: true },
  { value: 'results', label: 'Results', panel: <p>Final scores</p> },
]

function renderTabs(onChange?: (value: string) => void) {
  render(
    <Tabs
      label="Event pages"
      tabs={tabs}
      defaultValue="schedule"
      onChange={onChange}
    />,
  )
}

const tab = (name: string) => screen.getByRole('tab', { name })

test('clicking a tab selects it, and only it, and tells the listener', async () => {
  const user = userEvent.setup()
  const onChange = vi.fn()
  renderTabs(onChange)

  await user.click(tab('Draw'))

  expect(tab('Draw')).toHaveAttribute('aria-selected', 'true')
  expect(tab('Schedule')).toHaveAttribute('aria-selected', 'false')
  expect(onChange).toHaveBeenCalledExactlyOnceWith('draw')
})

test('the selected tab’s panel shows, named by its tab, and the others’ are hidden', async () => {
  const user = userEvent.setup()
  renderTabs()

  await user.click(tab('Results'))

  expect(screen.getByRole('tabpanel', { name: 'Results' })).toHaveTextContent(
    'Final scores',
  )
  expect(screen.queryByText('Today’s matches')).not.toBeVisible()
})

test('the tabs are one stop in the tab order: the selected tab', async () => {
  const user = userEvent.setup()
  render(
    <>
      <Tabs label="Event pages" tabs={tabs} defaultValue="draw" />
      <button type="button">After</button>
    </>,
  )

  await user.tab()
  expect(tab('Draw')).toHaveFocus()

  // Past the tabs, the selected tab's panel is the next stop.
  await user.tab()
  expect(screen.getByRole('tabpanel', { name: 'Draw' })).toHaveFocus()
})

test('the arrow keys select the next and previous enabled tab, wrapping, skipping a disabled one', async () => {
  const user = userEvent.setup()
  renderTabs()
  await user.tab()

  await user.keyboard('{ArrowRight}')
  expect(tab('Draw')).toHaveFocus()
  expect(tab('Draw')).toHaveAttribute('aria-selected', 'true')

  await user.keyboard('{ArrowRight}')
  expect(tab('Results')).toHaveFocus()
  expect(tab('Results')).toHaveAttribute('aria-selected', 'true')

  await user.keyboard('{ArrowRight}')
  expect(tab('Schedule')).toHaveFocus()

  await user.keyboard('{ArrowLeft}')
  expect(tab('Results')).toHaveFocus()
})

test('Home and End select the first and last enabled tab', async () => {
  const user = userEvent.setup()
  renderTabs()
  await user.tab()

  await user.keyboard('{End}')
  expect(tab('Results')).toHaveAttribute('aria-selected', 'true')

  await user.keyboard('{Home}')
  expect(tab('Schedule')).toHaveAttribute('aria-selected', 'true')
})

test('a disabled tab cannot be selected by clicking it', async () => {
  const user = userEvent.setup()
  renderTabs()

  await user.click(tab('Players'))

  expect(tab('Players')).toHaveAttribute('aria-selected', 'false')
  expect(tab('Schedule')).toHaveAttribute('aria-selected', 'true')
})

test('the tab list is named', () => {
  renderTabs()

  expect(screen.getByRole('tablist', { name: 'Event pages' })).toBeVisible()
})
