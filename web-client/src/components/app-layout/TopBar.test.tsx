import { screen } from '@testing-library/react'
import { describe, expect, vi } from 'vitest'
import { it } from '../../setupTests.ts'
import { AppLayoutPage } from '../AppLayout.page.tsx'

const props = { sidebarExpanded: true, sidebarId: 'sidebar', onToggleSidebar: () => {} }

describe('TopBar', () => {
  it('links its FortyMM brand to the dashboard, at /', async () => {
    const page = await AppLayoutPage.renderTopBar(props)
    expect(await page.findBrand()).toHaveAttribute('href', '/')
  })

  it('has no heading: each screen has its own', async () => {
    const page = await AppLayoutPage.renderTopBar(props)
    await page.findBanner()
    expect(screen.queryAllByRole('heading')).toHaveLength(0)
  })

  it('says the sidebar is collapsed on its toggle', async () => {
    const page = await AppLayoutPage.renderTopBar({ ...props, sidebarExpanded: false })
    expect(await page.findSidebarToggle()).toHaveAttribute('aria-expanded', 'false')
  })

  it('says the sidebar is expanded on its toggle', async () => {
    const page = await AppLayoutPage.renderTopBar(props)
    expect(await page.findSidebarToggle()).toHaveAttribute('aria-expanded', 'true')
  })

  it('points its toggle at the sidebar it controls', async () => {
    const page = await AppLayoutPage.renderTopBar(props)
    expect(await page.findSidebarToggle()).toHaveAttribute('aria-controls', 'sidebar')
  })

  it('asks the layout to toggle the sidebar when its toggle is pressed', async ({ user }) => {
    const onToggleSidebar = vi.fn()
    const page = await AppLayoutPage.renderTopBar({ ...props, onToggleSidebar })
    await user.click(await page.findSidebarToggle())
    expect(onToggleSidebar).toHaveBeenCalledOnce()
  })
})
