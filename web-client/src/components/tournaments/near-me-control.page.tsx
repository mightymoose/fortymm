import userEvent from '@testing-library/user-event'

import { render, screen, type Container } from '@/test/utilities'

import { NearMeControl, type NearMeControlProps } from './near-me-control'
import { buildNearMeControlProps } from './near-me-control.factory'

const scoped = (container: Container) => ({
  /** The "Near me" toggle (a Radix Switch → role `switch`). */
  getToggle() {
    return container.getByRole('switch', { name: /near me/i })
  },
  /** The radius picker's trigger (a Radix Select → role `combobox`). */
  getRadiusTrigger() {
    return container.getByRole('combobox', { name: /search radius/i })
  },
  /** The transient "Locating…" indicator — absent unless a request is in flight. */
  queryLocating() {
    return container.queryByText(/locating/i)
  },
  /** The inline "location unavailable" note — absent unless we fell back. */
  queryUnavailableNote() {
    return container.queryByRole('alert')
  },
  /** Toggle the switch (on or off — Radix flips the current state). */
  async clickToggle() {
    await userEvent.click(this.getToggle())
  },
  /** Open the radius picker and choose `${miles} mi` — options portal to the
   * body, so they resolve against `screen`, not the scoped container. */
  async selectRadius(miles: number) {
    await userEvent.click(this.getRadiusTrigger())
    await userEvent.click(
      await screen.findByRole('option', { name: `${miles} mi` }),
    )
  },
})

/** Test page-object for `NearMeControl`. Geolocation is the boundary under
 * test, so tests install their own `navigator.geolocation` mock before
 * rendering (granted / denied / undefined) and assert on `onNearMeChange`. */
export const nearMeControlPage = {
  render(overrides: Partial<NearMeControlProps> = {}) {
    render(<NearMeControl {...buildNearMeControlProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
