import { afterEach, describe, expect, it, vi } from 'vitest'

import { nearMeControlPage } from './near-me-control.page'

/** Install a `navigator.geolocation` whose `getCurrentPosition` resolves
 * synchronously to `(lat, lng)` — a granted permission. */
function grantAt(lat: number, lng: number) {
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: {
      getCurrentPosition: (
        success: PositionCallback,
      ) => success({ coords: { latitude: lat, longitude: lng } } as GeolocationPosition),
    },
  })
}

/** A geolocation whose `getCurrentPosition` invokes the error callback — a
 * denied permission (or any position error). */
function denyGeolocation() {
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: {
      getCurrentPosition: (
        _success: PositionCallback,
        error?: PositionErrorCallback,
      ) => error?.({ code: 1, message: 'User denied Geolocation' } as GeolocationPositionError),
    },
  })
}

/** Remove `navigator.geolocation` entirely — an insecure origin or an old
 * browser where the API does not exist. */
function removeGeolocation() {
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: undefined,
  })
}

afterEach(() => {
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: undefined,
  })
})

describe('NearMeControl', () => {
  it('emits the resolved lat/lng/radius triple when enabled and permission is granted', async () => {
    grantAt(37.7749, -122.4194)
    const onNearMeChange = vi.fn()
    nearMeControlPage.render({ onNearMeChange })

    await nearMeControlPage.clickToggle()

    // The triple the list query needs — the default 25 mi radius plus the
    // granted coordinates, parsed at the boundary.
    expect(onNearMeChange).toHaveBeenLastCalledWith({
      lat: 37.7749,
      lng: -122.4194,
      radiusMiles: 25,
    })
    // The toggle stays ON, and there is no lingering spinner or error note.
    expect(nearMeControlPage.getToggle()).toBeChecked()
    expect(nearMeControlPage.queryLocating()).toBeNull()
    expect(nearMeControlPage.queryUnavailableNote()).toBeNull()
  })

  it('re-queries with the new radius when it changes while located', async () => {
    grantAt(40.7128, -74.006)
    const onNearMeChange = vi.fn()
    nearMeControlPage.render({ onNearMeChange })

    await nearMeControlPage.clickToggle()
    onNearMeChange.mockClear()

    await nearMeControlPage.selectRadius(100)

    // Same coordinates, new radius — a fresh triple, so the list re-fetches.
    expect(onNearMeChange).toHaveBeenLastCalledWith({
      lat: 40.7128,
      lng: -74.006,
      radiusMiles: 100,
    })
  })

  it('falls back gracefully when permission is denied: unfiltered list, toggle off, inline note', async () => {
    denyGeolocation()
    const onNearMeChange = vi.fn()
    nearMeControlPage.render({ onNearMeChange })

    await nearMeControlPage.clickToggle()

    // No filter is sent — the full list stays.
    expect(onNearMeChange).toHaveBeenLastCalledWith(undefined)
    // The toggle snaps back off, and NO spinner is left spinning.
    expect(nearMeControlPage.getToggle()).not.toBeChecked()
    expect(nearMeControlPage.queryLocating()).toBeNull()
    // The inline note explains why location is unavailable.
    expect(nearMeControlPage.queryUnavailableNote()).toHaveTextContent(
      /location unavailable/i,
    )
  })

  it('falls back the same way when the geolocation API is unavailable', async () => {
    removeGeolocation()
    const onNearMeChange = vi.fn()
    nearMeControlPage.render({ onNearMeChange })

    await nearMeControlPage.clickToggle()

    expect(onNearMeChange).toHaveBeenLastCalledWith(undefined)
    expect(nearMeControlPage.getToggle()).not.toBeChecked()
    expect(nearMeControlPage.queryUnavailableNote()).toHaveTextContent(
      /location unavailable/i,
    )
  })

  it('clears the note and filters on a successful retry after a denial', async () => {
    denyGeolocation()
    const onNearMeChange = vi.fn()
    nearMeControlPage.render({ onNearMeChange })

    await nearMeControlPage.clickToggle()
    expect(nearMeControlPage.queryUnavailableNote()).not.toBeNull()

    // The user grants it and tries again — the note clears and the filter lands.
    grantAt(51.5074, -0.1278)
    await nearMeControlPage.clickToggle()

    expect(nearMeControlPage.queryUnavailableNote()).toBeNull()
    expect(onNearMeChange).toHaveBeenLastCalledWith({
      lat: 51.5074,
      lng: -0.1278,
      radiusMiles: 25,
    })
  })

  it('clears the filter when toggled back off', async () => {
    grantAt(37.7749, -122.4194)
    const onNearMeChange = vi.fn()
    nearMeControlPage.render({ onNearMeChange })

    await nearMeControlPage.clickToggle()
    onNearMeChange.mockClear()

    await nearMeControlPage.clickToggle()

    expect(onNearMeChange).toHaveBeenLastCalledWith(undefined)
    expect(nearMeControlPage.getToggle()).not.toBeChecked()
  })
})
