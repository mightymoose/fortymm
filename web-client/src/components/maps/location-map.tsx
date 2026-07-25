import { APIProvider, AdvancedMarker, Map } from '@vis.gl/react-google-maps'

import { cn } from '@/lib/utils'

export interface LocationMapProps {
  /** Latitude of the pin, in decimal degrees. */
  latitude: number
  /** Longitude of the pin, in decimal degrees. */
  longitude: number
  /**
   * Human-readable location. Titles the pin, and is shown verbatim as the text
   * fallback when no Google Maps key is configured.
   */
  label: string
  /** Map zoom level. Ignored by the text fallback. */
  zoom?: number
  /** Extra classes for the outer container — e.g. to override the height. */
  className?: string
}

const DEFAULT_ZOOM = 14

// Google's public demo vector style. `AdvancedMarker` needs a map ID to render,
// and this one works without a Cloud-configured map. Override with
// VITE_GOOGLE_MAPS_MAP_ID in a real deploy.
const DEMO_MAP_ID = 'DEMO_MAP_ID'

/**
 * Display-only venue map: renders a single pin at (`latitude`, `longitude`) with
 * Google Maps via `@vis.gl/react-google-maps`, reading the browser key from
 * `VITE_GOOGLE_MAPS_API_KEY`.
 *
 * When no key is configured (dev/CI/e2e all run keyless) it degrades gracefully
 * to a text fallback of `label` — it never loads Google and never throws. This
 * component only *renders* coordinates; it does not author them.
 */
export const LocationMap = ({
  latitude,
  longitude,
  label,
  zoom = DEFAULT_ZOOM,
  className,
}: LocationMapProps) => {
  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY
  const position = { lat: latitude, lng: longitude }

  if (!apiKey) {
    return (
      <div
        data-testid="location-map-fallback"
        className={cn(
          'flex min-h-32 items-center justify-center rounded-lg border border-[color:var(--border)] bg-[color:var(--bg-2)] p-4 text-center',
          className,
        )}
      >
        <span className="text-sm text-[color:var(--fg-3)]">{label}</span>
      </div>
    )
  }

  const mapId = import.meta.env.VITE_GOOGLE_MAPS_MAP_ID || DEMO_MAP_ID

  return (
    <div
      data-testid="location-map"
      className={cn('h-48 overflow-hidden rounded-lg', className)}
    >
      <APIProvider apiKey={apiKey}>
        <Map
          defaultCenter={position}
          defaultZoom={zoom}
          mapId={mapId}
          gestureHandling="cooperative"
          disableDefaultUI
        >
          <AdvancedMarker position={position} title={label} />
        </Map>
      </APIProvider>
    </div>
  )
}
