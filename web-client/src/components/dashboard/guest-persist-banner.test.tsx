import { userEvent } from '@testing-library/user-event'

import { waitFor } from '@/test/utilities'

import { buildGuestPersistBannerView } from './guest-persist-banner.factory'
import { GUEST_PERSIST_DISMISS_KEY } from './guest-persist-banner'
import { guestPersistBannerPage as page } from './guest-persist-banner.page'

describe('GuestPersistBanner', () => {
  beforeEach(() => {
    window.sessionStorage.removeItem(GUEST_PERSIST_DISMISS_KEY)
  })

  it('quotes the match count and rating and links to settings', async () => {
    page.render({
      view: buildGuestPersistBannerView({ matchCount: 4, rating: 1847 }),
    })

    const banner = await page.findBanner()
    expect(banner).toHaveTextContent('4')
    expect(banner).toHaveTextContent(/matches and rating/i)
    expect(banner).toHaveTextContent('1847')
    expect(banner).toHaveTextContent(/live on this device only/i)
    expect(page.getCta()).toHaveAttribute('href', '/settings#sec-email')
  })

  it('uses the singular noun and drops the rating fragment for one unrated match', async () => {
    page.render({
      view: buildGuestPersistBannerView({ matchCount: 1, rating: null }),
    })

    const banner = await page.findBanner()
    expect(banner).toHaveTextContent('Your 1 match live on this device only.')
    expect(banner).not.toHaveTextContent(/rating/i)
  })

  it('dismisses for the session on click', async () => {
    page.render()

    await page.findBanner()
    await userEvent.click(page.getDismissButton())

    await waitFor(() => expect(page.queryBanner()).not.toBeInTheDocument())
    expect(window.sessionStorage.getItem(GUEST_PERSIST_DISMISS_KEY)).toBe('1')
  })

  it('stays hidden when already dismissed this session', async () => {
    window.sessionStorage.setItem(GUEST_PERSIST_DISMISS_KEY, '1')
    page.render()

    // The router still resolves; the banner just never appears.
    await Promise.resolve()
    expect(page.queryBanner()).not.toBeInTheDocument()
  })
})
