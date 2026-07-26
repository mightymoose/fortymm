import { useState } from 'react'
import { MapPin, MapPinOff } from 'lucide-react'

import {
  type GeocodePreview,
  isAddressNotGeocodable,
  previewGeocode,
} from '@/api/geocode'
import { notifyError } from '@/lib/notify-error'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'

import { LocationMap } from './location-map'

/** The six free-text venue components as currently typed on the write surface.
 * `country` is optional — the create modal has no country field, only the edit
 * form does — but the rest are always present (empty strings when unfilled). */
export interface PreviewAddress {
  venue: string
  street: string
  city: string
  region: string
  postal: string
  country?: string
}

export interface PreviewLocationProps {
  /** The address to geocode, read live from the surrounding form. */
  address: PreviewAddress
}

/** Compose the typed parts into one address line for the geocoder, dropping the
 * blanks so an empty region/venue doesn't wedge stray commas into the query. */
function composeAddress(address: PreviewAddress): string {
  return [
    address.venue,
    address.street,
    address.city,
    address.region,
    address.postal,
    address.country,
  ]
    .map((part) => part?.trim() ?? '')
    .filter(Boolean)
    .join(', ')
}

/** `idle` → the button, no pin. `pending` → the in-flight state that always
 * resolves (never a permanent spinner). `located` → a `LocationMap` pin at the
 * geocoded coords. `not_found` → the inline "we couldn't locate that address"
 * note, and no pin. */
type PreviewState =
  | { status: 'idle' }
  | { status: 'pending' }
  | { status: 'located'; preview: GeocodePreview }
  | { status: 'not_found' }

/**
 * The shared "Preview location" affordance on both tournament write surfaces (the
 * create modal and the edit form). It geocodes the currently-typed venue address
 * via `GET /v1/geocode` on a user action — fetch-on-click, its own request, never
 * on load — and drops a confirmation pin so the organizer can confirm the venue
 * *before* saving.
 *
 * It is display-only confirmation: it adds NO coordinates to the create/edit
 * submit payload (the server geocodes on save; the write shape stays
 * coordinate-free). An unresolvable address surfaces inline ("we couldn't locate
 * that address") with no pin — the coded `409` both this endpoint and the write
 * path answer with. Any other failure is a toast, so a real address is never
 * blamed for a server outage.
 */
export const PreviewLocation = ({ address }: PreviewLocationProps) => {
  const [state, setState] = useState<PreviewState>({ status: 'idle' })

  const preview = async () => {
    setState({ status: 'pending' })
    try {
      const result = await previewGeocode(composeAddress(address))
      setState({ status: 'located', preview: result })
    } catch (error) {
      // The coded "zero candidates" 409 is the one failure told inline — the
      // organizer's address didn't resolve. Everything else (a 5xx, an outage, a
      // 403, or another 409 whose code is not `address_not_geocodable`) is not
      // about their address, so it toasts and the button returns to idle rather
      // than accusing a good address of being unlocatable.
      if (isAddressNotGeocodable(error)) {
        setState({ status: 'not_found' })
        return
      }
      notifyError('preview the location')(error)
      setState({ status: 'idle' })
    }
  }

  return (
    <div className="flex flex-col gap-2" data-testid="preview-location">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={preview}
        disabled={state.status === 'pending'}
        className="self-start"
      >
        <MapPin size={16} />
        {state.status === 'pending' ? 'Locating…' : 'Preview location'}
      </Button>

      {state.status === 'located' && (
        <LocationMap
          latitude={state.preview.latitude}
          longitude={state.preview.longitude}
          // The provider's canonical label when it gave one, else the venue name
          // the organizer typed — never an empty pin title.
          label={state.preview.formatted || address.venue}
          className="h-44 max-w-md"
        />
      )}

      {state.status === 'not_found' && (
        <Alert
          variant="destructive"
          data-testid="preview-location-error"
          className="max-w-md"
        >
          <MapPinOff />
          <AlertTitle>We couldn&rsquo;t locate that address</AlertTitle>
          <AlertDescription>
            Check the venue details and try again. Nothing was saved.
          </AlertDescription>
        </Alert>
      )}
    </div>
  )
}
