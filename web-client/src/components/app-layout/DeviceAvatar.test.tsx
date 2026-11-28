import { afterEach, describe, expect, vi } from 'vitest'
import { whoami, type Identity } from '../../device/whoami.ts'
import { it } from '../../setupTests.ts'
import { AppLayoutPage } from '../AppLayout.page.tsx'

// jsdom has no IndexedDB or Web Locks, so the device's identity is stood in for here; the real one,
// from a real key, is shown in the browser (e2e/app-layout.spec.ts).
vi.mock('../../device/whoami.ts')

const props = { sidebarExpanded: true, sidebarId: 'sidebar', onToggleSidebar: () => {} }

const identity: Identity = {
  accountId: 'ab'.repeat(32),
  playerId: 'cd'.repeat(32),
  username: 'agile-meerkat-4b8z',
  usernameConfirmed: false,
  account: 'guest',
}

afterEach(() => {
  vi.mocked(whoami).mockReset()
})

describe('DeviceAvatar', () => {
  it("is named by the device's username", async () => {
    vi.mocked(whoami).mockResolvedValue({ ok: true, identity })
    const page = await AppLayoutPage.renderTopBar(props)
    expect(await page.findAvatar()).toHaveAccessibleName('agile-meerkat-4b8z')
  })

  it("shows the first letters of the username's first two words", async () => {
    vi.mocked(whoami).mockResolvedValue({ ok: true, identity })
    const page = await AppLayoutPage.renderTopBar(props)
    expect(await page.findAvatar()).toHaveTextContent('AM')
  })

  it('shows the whole username beside the avatar', async () => {
    vi.mocked(whoami).mockResolvedValue({ ok: true, identity })
    const page = await AppLayoutPage.renderTopBar(props)
    expect(await page.findShownUsername('agile-meerkat-4b8z')).toBeInTheDocument()
  })

  it("hides the shown username from assistive technology, which hears it as the avatar's name", async () => {
    vi.mocked(whoami).mockResolvedValue({ ok: true, identity })
    const page = await AppLayoutPage.renderTopBar(props)
    expect(await page.findShownUsername('agile-meerkat-4b8z')).toHaveAttribute('aria-hidden', 'true')
  })

  it('is not shown when the device has no identity', async () => {
    vi.mocked(whoami).mockResolvedValue({ ok: false, reason: 'storage-unavailable' })
    const page = await AppLayoutPage.renderTopBar(props)
    await vi.waitUntil(() => vi.mocked(whoami).mock.results.length > 0)
    await vi.mocked(whoami).mock.results[0]!.value
    expect(page.queryAvatar()).toBeNull()
  })
})
