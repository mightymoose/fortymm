import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test } from 'vitest'
import { renderScreen } from '../test/render-screen.tsx'
import { TabNav, type TabLink } from './TabNav.tsx'

// Paths of the app's own: a link's `to` is typed by the router.
const links: TabLink[] = [
  { to: '/design-system/colour', label: 'Colour' },
  { to: '/design-system/type', label: 'Type' },
  { to: '/design-system/feedback', label: 'Feedback' },
]

function renderTabNav(path: string) {
  renderScreen(
    <>
      <button type="button">Before</button>
      <TabNav label="Design system" links={links} />
    </>,
    { path },
  )
}

const nav = () => screen.getByRole('navigation', { name: 'Design system' })
const link = (name: string) => within(nav()).getByRole('link', { name })

test('the tabs are a navigation landmark named by its label, a link per tab to its page', async () => {
  renderTabNav('/design-system/colour')

  expect(await screen.findByRole('link', { name: 'Type' })).toHaveAttribute(
    'href',
    '/design-system/type',
  )
  expect(within(nav()).getAllByRole('link')).toHaveLength(3)
})

test('the tab of the page at the address is the current page, and no other', async () => {
  renderTabNav('/design-system/type')

  expect(await screen.findByRole('link', { name: 'Type' })).toHaveAttribute(
    'aria-current',
    'page',
  )
  expect(link('Colour')).not.toHaveAttribute('aria-current')
  expect(link('Feedback')).not.toHaveAttribute('aria-current')
})

test('following a tab makes it the current page', async () => {
  const user = userEvent.setup()
  renderTabNav('/design-system/colour')

  await user.click(await screen.findByRole('link', { name: 'Feedback' }))

  expect(link('Feedback')).toHaveAttribute('aria-current', 'page')
  expect(link('Colour')).not.toHaveAttribute('aria-current')
})

test('each tab is a stop in the tab order', async () => {
  const user = userEvent.setup()
  renderTabNav('/design-system/colour')
  await screen.findByRole('link', { name: 'Colour' })

  await user.click(screen.getByRole('button', { name: 'Before' }))
  for (const name of ['Colour', 'Type', 'Feedback']) {
    await user.tab()
    expect(link(name)).toHaveFocus()
  }
})
