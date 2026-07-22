import userEvent from '@testing-library/user-event'

import { waitFor } from '@/test/utilities'
import { PERM } from '@/lib/permissions'

import { agentAccessSectionPage as page } from './agent-access-section.page'

describe('AgentAccessSection', () => {
  it('renders nothing for a user without mcp.access', async () => {
    page.signInWithPermissions([])
    page.mockLinkStatus(false)
    page.render()

    // Wait for the session to actually resolve — otherwise the absence is just
    // the still-loading state and proves nothing.
    await page.findSessionReady()
    expect(page.querySection()).not.toBeInTheDocument()
  })

  it('shows a Connect link to the Auth0 start flow when the user is permitted but unlinked', async () => {
    page.signInWithPermissions([PERM.MCP_ACCESS])
    page.mockLinkStatus(false)
    page.render()

    const connect = await page.findConnectLink()
    // A real navigation to the API's OAuth-redirect endpoint, not a fetch.
    expect(connect.getAttribute('href')).toContain('/v1/auth0/link/start')
    expect(page.queryUnlinkButton()).not.toBeInTheDocument()
    expect(page.queryConnectedBadge()).not.toBeInTheDocument()
  })

  it('shows Connected status and an Unlink control when the user is linked', async () => {
    page.signInWithPermissions([PERM.MCP_ACCESS])
    page.mockLinkStatus(true)
    page.render()

    expect(await page.findUnlinkButton()).toBeInTheDocument()
    expect(page.queryConnectedBadge()).toBeInTheDocument()
    expect(page.queryConnectLink()).not.toBeInTheDocument()
  })

  it('calls DELETE and flips to the unlinked state when Unlink is clicked', async () => {
    page.signInWithPermissions([PERM.MCP_ACCESS])
    page.mockLinkStatus(true)
    page.stubUnlink()
    page.render()

    const unlink = await page.findUnlinkButton()
    await userEvent.click(unlink)

    // The Connect link is the tell that the section flipped to "not connected".
    const connect = await page.findConnectLink()
    expect(connect).toBeInTheDocument()
    expect(page.queryUnlinkButton()).not.toBeInTheDocument()
    await waitFor(() => expect(page.unlinkCallCount()).toBe(1))
  })
})
