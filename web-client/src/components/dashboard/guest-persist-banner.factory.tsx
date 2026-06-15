import type { GuestPersistBannerProps } from './guest-persist-banner'
import type { GuestPersistBannerView } from './guest-persist-banner/guest-persist-banner-view'

/** A guest with four completed matches and a 1847 rating. */
export function buildGuestPersistBannerView(
  overrides: Partial<GuestPersistBannerView> = {},
): GuestPersistBannerView {
  return { matchCount: 4, rating: 1847, ...overrides }
}

/** Props for `GuestPersistBanner`. */
export function buildGuestPersistBannerProps(
  overrides: Partial<GuestPersistBannerProps> = {},
): GuestPersistBannerProps {
  return { view: buildGuestPersistBannerView(), ...overrides }
}
