import { render, screen, type Container } from '@/test/utilities'

import { LocationMap, type LocationMapProps } from './location-map'
import { buildLocationMapProps } from './location-map.factory'

const scoped = (container: Container) => ({
  /** The map container — present only when a Maps key is configured. */
  queryMap() {
    return container.queryByTestId('location-map')
  },
  /** The text fallback shown when no Maps key is configured; else null. */
  queryFallback() {
    return container.queryByTestId('location-map-fallback')
  },
  /** The text fallback; throws if it is absent (a key was configured). */
  getFallback() {
    return container.getByTestId('location-map-fallback')
  },
  /** The label element *inside* the fallback — the box that has to wrap an
   * unbroken venue name (#1199), as opposed to the padded container around it. */
  getFallbackLabel() {
    return container.getByTestId('location-map-fallback-label')
  },
})

/**
 * Test page-object for `LocationMap`. The Google Maps library is inert in
 * jsdom, so tests that exercise the key-present branch must mock
 * `@vis.gl/react-google-maps`; this page object only touches the component's own
 * `location-map` / `location-map-fallback` containers.
 */
export const locationMapPage = {
  render(overrides: Partial<LocationMapProps> = {}) {
    render(<LocationMap {...buildLocationMapProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
