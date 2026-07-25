// The read-only "Preview location" lookup (`GET /v1/geocode`). Geocodes a
// free-text venue address to coordinates for a confirmation pin, WITHOUT writing
// anything — the tournament create/edit surfaces call it on a user action (the
// "Preview location" button), so it is its own endpoint rather than folded into a
// page's BFF payload (root CLAUDE.md, "BFF endpoints").

import { z } from 'zod'

import { ApiError, api, unwrap } from './client'

/** The wire's `GeocodePreview` — parsed at the fetch boundary (web-client
 * CLAUDE.md "Boundaries"). The generated `schema.d.ts` gives the compile-time
 * shape; this gives the runtime guarantee. */
export const geocodePreviewSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
  formatted: z.string(),
})

export type GeocodePreview = z.infer<typeof geocodePreviewSchema>

/** The coded reason a `422` carries when an address resolves to zero candidates.
 * The preview endpoint answers with the SAME code the create/edit write path
 * uses, so "we couldn't locate that address" is one refusal, told once. */
export const ADDRESS_NOT_GEOCODABLE = 'address_not_geocodable'

/**
 * True when `error` is the coded "unresolvable address" `422` — the one failure
 * the preview surfaces INLINE ("we couldn't locate that address"). Every other
 * failure (a 5xx, an outage, a 403) is not this, and the caller toasts it instead
 * of implying the organizer typed a bad address. Reads the structured code off
 * the stored `ApiError.body`, never the bare status.
 */
export function isAddressNotGeocodable(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 422) return false
  const detail = (error.body as { detail?: unknown } | null | undefined)?.detail
  return (
    !!detail &&
    typeof detail === 'object' &&
    !Array.isArray(detail) &&
    (detail as { code?: unknown }).code === ADDRESS_NOT_GEOCODABLE
  )
}

/**
 * Resolve a free-text `address` to coordinates for the preview pin. Throws an
 * `ApiError` on failure — the caller distinguishes the coded "unresolvable"
 * `422` (`isAddressNotGeocodable`) from everything else. The 2xx body is
 * Zod-parsed before it flows inward.
 */
export async function previewGeocode(address: string): Promise<GeocodePreview> {
  const data = unwrap(
    'preview the location',
    await api.GET('/v1/geocode', { params: { query: { address } } }),
  )
  return geocodePreviewSchema.parse(data)
}
