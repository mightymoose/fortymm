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
          // `overflow-y-auto` is the other half of the wrap below. Both call sites
          // give this box a FIXED height (`h-44`) because it stands in for a map,
          // and a wrapped 680-character venue line is taller than that: without it
          // the label spills out of its own border and lands on top of the stat
          // strip underneath. Scrolled, every character is still reachable — which
          // is why this is not the clamp the fix rules out; and the venue line
          // directly above this box already carries the name in full anyway.
          //
          // `items-center-safe` (align-items: SAFE center), not `items-center`, and
          // it is load-bearing: a centred flex item that overflows its container
          // overflows it at BOTH ends, and the part above the top edge cannot be
          // scrolled to — no scroll position reaches it. Measured: with plain
          // `items-center` the placeholder opened mid-word, ~60px of the venue name
          // permanently unreachable. `safe` falls back to `start` the moment the
          // content does not fit, so the label begins at the top and every line
          // below it is one scroll away.
          'flex min-h-32 items-center-safe justify-center overflow-y-auto rounded-lg border border-[color:var(--border)] bg-[color:var(--bg-2)] p-4 text-center',
          className,
        )}
      >
        {/* The label is a venue line, and a venue line can be one unbroken
            680-character string (the read shape bounds no address component —
            `api/app/schemas/tournament.py`). Unwrapped it is a flex item whose
            min-content width is the whole word, so it paints straight out of this
            box and drags the document's scroll width past the viewport (#1199).
            `wrap-anywhere` (overflow-wrap: anywhere) is what shrinks the item's
            min-content contribution; `break-words` would not. It wraps rather than
            clamps on purpose: the fallback exists to SAY where the venue is. */}
        <span
          data-testid="location-map-fallback-label"
          className="min-w-0 wrap-anywhere text-sm text-[color:var(--fg-3)]"
        >
          {label}
        </span>
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
