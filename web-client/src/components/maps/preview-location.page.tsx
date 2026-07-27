import { render, screen, type Container } from '@/test/utilities'

import { PreviewLocation, type PreviewLocationProps } from './preview-location'
import { buildPreviewLocationProps } from './preview-location.factory'

const scoped = (container: Container) => ({
  /** The "Preview location" button — its label flips to "Locating…" in flight. */
  getPreviewButton() {
    return container.getByRole('button', { name: /Preview location|Locating/ })
  },
  /** The confirmation pin's text fallback (dev/CI/e2e run keyless), present only
   * after a resolvable address geocodes; else null. */
  queryPin() {
    return container.queryByTestId('location-map-fallback')
  },
  /** The inline "we couldn't locate that address" note — present only on the
   * coded 422 path; else null. */
  queryError() {
    return container.queryByTestId('preview-location-error')
  },
  findError() {
    return container.findByTestId('preview-location-error')
  },
  /** The neutral "add a venue address" hint — present only when every venue
   * field is blank; else null. Distinct from `queryError`, which is the
   * destructive "we couldn't locate that address" alert. */
  queryHint() {
    return container.queryByTestId('preview-location-hint')
  },
  findHint() {
    return container.findByTestId('preview-location-hint')
  },
})

/**
 * Test page-object for `PreviewLocation`. The geocode call goes through the
 * `openapi-fetch` client, so tests must have an MSW handler for `GET /v1/geocode`
 * (the default handler resolves normal addresses and 422s the `__unresolvable__`
 * sentinel). The Google Maps library is inert in jsdom, so the pin asserts via
 * the `location-map-fallback` text.
 */
export const previewLocationPage = {
  render(overrides: Partial<PreviewLocationProps> = {}) {
    render(<PreviewLocation {...buildPreviewLocationProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
