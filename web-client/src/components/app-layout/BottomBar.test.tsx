import { describe, expect } from 'vitest'
import { it } from '../../setupTests.ts'
import { AppLayoutPage } from '../AppLayout.page.tsx'

describe('BottomBar', () => {
  it('links to the dashboard, matches and users, then New match, in that order', async () => {
    const page = await AppLayoutPage.renderBottomBar()
    const links = await page.findBottomBarLinks()
    expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Dashboard', '/'],
      ['Matches', '/matches'],
      ['Users', '/users'],
      ['New match', '/matches/new'],
    ])
  })

  it.each([
    { path: '/', current: 'Dashboard' },
    { path: '/matches', current: 'Matches' },
    { path: '/matches/new', current: 'New match' },
    { path: '/users', current: 'Users' },
  ])('at $path, marks $current as the current page, and no other', async ({ path, current }) => {
    const page = await AppLayoutPage.renderBottomBar({ path })
    expect(AppLayoutPage.current(await page.findBottomBarLinks())).toEqual([current])
  })

  it('at /settings, marks no link as the current page', async () => {
    const page = await AppLayoutPage.renderBottomBar({ path: '/settings' })
    expect(AppLayoutPage.current(await page.findBottomBarLinks())).toEqual([])
  })
})
