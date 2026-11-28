import { describe, expect } from 'vitest'
import { it } from '../../setupTests.ts'
import { AppLayoutPage } from '../AppLayout.page.tsx'

describe('Sidebar', () => {
  it('links to the dashboard, matches, users, admin and settings, in that order', async () => {
    const page = await AppLayoutPage.renderSidebar()
    const links = await page.findSidebarLinks()
    expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Dashboard', '/'],
      ['Matches', '/matches'],
      ['Users', '/users'],
      ['Admin', '/admin'],
      ['Settings', '/settings'],
    ])
  })

  it.each([
    { path: '/', current: 'Dashboard' },
    { path: '/matches', current: 'Matches' },
    { path: '/matches/new', current: 'Matches' },
    { path: '/users', current: 'Users' },
    { path: '/admin', current: 'Admin' },
    { path: '/settings', current: 'Settings' },
  ])('at $path, marks $current as the current page, and no other', async ({ path, current }) => {
    const page = await AppLayoutPage.renderSidebar({ path })
    expect(AppLayoutPage.current(await page.findSidebarLinks())).toEqual([current])
  })

  it('collapsed, shows each link’s icon only', async () => {
    const page = await AppLayoutPage.renderSidebar({ expanded: false })
    const links = await page.findSidebarLinks()
    expect(links.map((link) => link.textContent)).toEqual(['', '', '', '', ''])
  })

  it('collapsed, names each link by its tooltip', async () => {
    const page = await AppLayoutPage.renderSidebar({ expanded: false })
    expect(await page.findSidebarLink('Users')).toBeInTheDocument()
  })

  it('collapsed, shows no tooltip until a link is pointed at or focused', async () => {
    const page = await AppLayoutPage.renderSidebar({ expanded: false })
    await page.findSidebar()
    expect(page.tooltip()).toBeNull()
  })

  it('collapsed, shows a link’s name as a tooltip while it is pointed at', async ({ user }) => {
    const page = await AppLayoutPage.renderSidebar({ expanded: false })
    await user.hover(await page.findSidebarLink('Users'))
    expect(page.tooltip()).toHaveTextContent('Users')
  })

  it('collapsed, hides the tooltip when the pointer leaves', async ({ user }) => {
    const page = await AppLayoutPage.renderSidebar({ expanded: false })
    const users = await page.findSidebarLink('Users')
    await user.hover(users)
    await user.unhover(users)
    expect(page.tooltip()).toBeNull()
  })

  it('collapsed, shows a link’s name as a tooltip while it has keyboard focus', async ({ user }) => {
    const page = await AppLayoutPage.renderSidebar({ expanded: false })
    await page.findSidebar()
    await user.tab()
    await user.tab()
    expect(page.tooltip()).toHaveTextContent('Matches')
  })

  it('collapsed, hides a focused link’s tooltip on Escape', async ({ user }) => {
    const page = await AppLayoutPage.renderSidebar({ expanded: false })
    await page.findSidebar()
    await user.tab()
    await user.keyboard('{Escape}')
    expect(page.tooltip()).toBeNull()
  })

  it('expanded, shows no tooltip when a link is pointed at: its label is shown', async ({ user }) => {
    const page = await AppLayoutPage.renderSidebar()
    await user.hover(await page.findSidebarLink('Users'))
    expect(page.tooltip()).toBeNull()
  })
})
