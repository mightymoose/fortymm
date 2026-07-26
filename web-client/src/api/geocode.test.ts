import { describe, expect, it } from 'vitest'

import { ApiError } from './client'
import { ADDRESS_NOT_GEOCODABLE, isAddressNotGeocodable } from './geocode'

/** The coded refusal `previewGeocode` (and the create/edit write path) answers a
 * zero-result address with. It is a `409` — the same status the OTHER tournament
 * refusals use — so the classifier must discriminate on the coded `detail`, never
 * the bare status. */
const geocodeRefusal = (code = ADDRESS_NOT_GEOCODABLE) =>
  new ApiError(409, "We couldn't locate that address.", 'preview the location', {
    detail: { code, message: "We couldn't locate that address." },
  })

describe('isAddressNotGeocodable', () => {
  it('recognizes the coded 409 the preview/write path answers an unresolvable address with', () => {
    expect(isAddressNotGeocodable(geocodeRefusal())).toBe(true)
  })

  it('does NOT confuse another 409 refusal (plain-string detail) for an unlocatable address', () => {
    // league-not-editable / draw-under-way carry a bare `detail` STRING under the
    // same 409 — a status-only check would misclassify them.
    const drawUnderWay = new ApiError(
      409,
      'The draw is already under way.',
      'save the tournament',
      { detail: 'The draw is already under way.' },
    )
    expect(isAddressNotGeocodable(drawUnderWay)).toBe(false)
  })

  it('does NOT match a 409 whose code is something else', () => {
    expect(isAddressNotGeocodable(geocodeRefusal('registration_closed'))).toBe(
      false,
    )
  })

  it('does NOT match the same coded body under a different status (a stale 422)', () => {
    const asFourTwentyTwo = new ApiError(
      422,
      "We couldn't locate that address.",
      'preview the location',
      { detail: { code: ADDRESS_NOT_GEOCODABLE, message: 'x' } },
    )
    expect(isAddressNotGeocodable(asFourTwentyTwo)).toBe(false)
  })

  it('is false for a non-ApiError and for a null body', () => {
    expect(isAddressNotGeocodable(new Error('boom'))).toBe(false)
    expect(
      isAddressNotGeocodable(
        new ApiError(409, null, 'preview the location', null),
      ),
    ).toBe(false)
  })
})
