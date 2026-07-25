import type { LocationMapProps } from './location-map'

/**
 * Props for `LocationMap` — a pin on the Oakland Convention Center, the kind of
 * venue a tournament detail page shows.
 */
export function buildLocationMapProps(
  overrides: Partial<LocationMapProps> = {},
): LocationMapProps {
  return {
    latitude: 37.8014,
    longitude: -122.2711,
    label: '1001 Broadway, Oakland, CA 94607',
    ...overrides,
  }
}
