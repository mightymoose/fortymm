import type { Locator, Page } from '@playwright/test'

// The layout the app's screens share (src/components/AppLayout.tsx): what a browser shows of it at
// a width, which jsdom can't (it applies no breakpoint).
export class AppLayoutPage {
  private readonly page: Page
  public readonly sidebar: Locator
  public readonly sidebarToggle: Locator
  public readonly bottomBar: Locator
  public readonly toast: Locator
  // The device's avatar in the top bar, named by its username (src/components/app-layout/
  // DeviceAvatar.tsx).
  public readonly avatar: Locator
  public readonly brand: Locator
  // The whole username beside the avatar, at non-phone widths.
  public readonly shownUsername: Locator

  constructor(page: Page) {
    this.page = page
    this.sidebar = page.getByRole('navigation', { name: 'Main' })
    this.sidebarToggle = page.getByRole('button', { name: 'Sidebar' })
    this.bottomBar = page.getByRole('navigation', { name: 'Bottom bar' })
    this.toast = page.getByTestId('stand-in-toast')
    this.avatar = page.getByRole('banner').getByRole('img')
    this.brand = page.getByRole('banner').getByRole('link', { name: 'FortyMM' })
    this.shownUsername = page.getByRole('banner').getByText(/^[a-z]+-[a-z]+-[0-9a-z]{4}$/)
  }

  // Phone widths are under 768px (AppLayout.css's breakpoint).
  async gotoOnPhone(path = '/') {
    await this.page.setViewportSize({ width: 390, height: 844 })
    await this.goto(path)
  }

  async gotoOnDesktop(path = '/') {
    await this.page.setViewportSize({ width: 1280, height: 800 })
    await this.goto(path)
  }

  // Resolves once the layout is on screen: the page's load event comes before React has rendered
  // it, and what a test measures (a toast's place, the brand's) depends on it being there.
  private async goto(path: string) {
    await this.page.goto(path)
    await this.page.getByRole('banner').waitFor()
  }

  // Puts a toast on the page, in the kit's toast region, as the app's toasts are (the new-version
  // one only shows on a production build with a new service worker waiting, which the dev server
  // never has). Resolves once it is there.
  async showToast() {
    await this.page.evaluate(`{
      const region = document.createElement('div')
      region.className = 'fm-toast-region'
      region.innerHTML = '<div class="fm-toast" data-testid="stand-in-toast">A toast.</div>'
      document.body.append(region)
    }`)
    await this.toast.waitFor()
  }

  // The username the avatar is named by, once it is shown.
  async findUsername(): Promise<string> {
    await this.avatar.waitFor()
    return (await this.avatar.getAttribute('aria-label')) ?? ''
  }

  // How far the centre of the brand is from the centre of the page, across (0 if centred).
  async brandOffCentre() {
    const brand = await this.brand.boundingBox()
    const width = this.page.viewportSize()?.width
    if (!brand || width === undefined) throw new Error('the brand is not shown')
    return Math.abs(brand.x + brand.width / 2 - width / 2)
  }

  // How far the toast's bottom edge is above the bottom bar's top edge (negative if it overlaps).
  async toastClearanceAboveBottomBar() {
    const toast = await this.toast.boundingBox()
    const bar = await this.bottomBar.boundingBox()
    if (!toast || !bar) throw new Error('the toast or the bottom bar is not shown')
    return bar.y - (toast.y + toast.height)
  }
}
