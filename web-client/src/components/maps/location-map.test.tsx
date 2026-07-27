import type { ReactNode } from 'react'

// jsdom has no Google Maps runtime, so replace the library with inert doubles.
// `mapProps` / `markerProps` capture what the component passes so we can assert
// the pin is centered on the given coordinates without loading Google.
const { mapProps, markerProps } = vi.hoisted(() => ({
  mapProps: vi.fn(),
  markerProps: vi.fn(),
}))

vi.mock('@vis.gl/react-google-maps', () => ({
  APIProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Map: (props: { children: ReactNode; [k: string]: unknown }) => {
    mapProps(props)
    return <div data-testid="mock-map">{props.children}</div>
  },
  AdvancedMarker: (props: Record<string, unknown>) => {
    markerProps(props)
    return <div data-testid="mock-marker" />
  },
}))

// Imported after the mock is declared (vi.mock is hoisted above all imports).
import { UNBREAKABLE_VENUE_NAME } from '@/mocks/factories/tournaments/tournament.factory'

import { locationMapPage } from './location-map.page'

const KEY = 'VITE_GOOGLE_MAPS_API_KEY'

describe('LocationMap', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    mapProps.mockClear()
    markerProps.mockClear()
  })

  describe('with no Maps key configured', () => {
    beforeEach(() => {
      vi.stubEnv(KEY, '')
    })

    it('renders the label as a text fallback instead of a map', () => {
      locationMapPage.render({ label: '1001 Broadway, Oakland, CA 94607' })

      expect(locationMapPage.getFallback()).toHaveTextContent(
        '1001 Broadway, Oakland, CA 94607',
      )
      expect(locationMapPage.queryMap()).toBeNull()
    })

    /** A venue line can be one unbroken 680-character word — the read shape bounds
     * no address component — and unwrapped it paints straight out of this box and
     * takes the whole page's scroll width with it (#1199).
     *
     * A markup supplement only: jsdom does no layout, so nothing here can measure
     * the overflow. `e2e/tournaments/tournament-venue.spec.ts` does. */
    it('asks the label to wrap, so an unbroken venue name cannot overflow it', () => {
      locationMapPage.render({ label: UNBREAKABLE_VENUE_NAME })

      const label = locationMapPage.getFallbackLabel()
      expect(label).toHaveTextContent(UNBREAKABLE_VENUE_NAME)
      expect(label).toHaveClass('wrap-anywhere')
    })

    it('does not load the Google Maps library', () => {
      locationMapPage.render()

      expect(mapProps).not.toHaveBeenCalled()
      expect(markerProps).not.toHaveBeenCalled()
    })
  })

  describe('with a Maps key configured', () => {
    beforeEach(() => {
      vi.stubEnv(KEY, 'test-browser-key')
    })

    it('renders the map instead of the text fallback', () => {
      locationMapPage.render()

      expect(locationMapPage.queryMap()).not.toBeNull()
      expect(locationMapPage.queryFallback()).toBeNull()
    })

    it('centers the map and the pin on the given coordinates', () => {
      locationMapPage.render({ latitude: 40.7128, longitude: -74.006 })

      expect(mapProps).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultCenter: { lat: 40.7128, lng: -74.006 },
        }),
      )
      expect(markerProps).toHaveBeenCalledWith(
        expect.objectContaining({
          position: { lat: 40.7128, lng: -74.006 },
        }),
      )
    })

    it('titles the pin with the label', () => {
      locationMapPage.render({ label: 'Center Court' })

      expect(markerProps).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Center Court' }),
      )
    })
  })
})
