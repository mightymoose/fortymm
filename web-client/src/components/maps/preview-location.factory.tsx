import type { PreviewLocationProps } from './preview-location'

/** Props for `PreviewLocation` — a fully-typed Berkeley venue address, the kind
 * a real preview geocodes. Override any field to exercise the blank/partial
 * composition paths. */
export function buildPreviewLocationProps(
  overrides: Partial<PreviewLocationProps> = {},
): PreviewLocationProps {
  return {
    address: {
      venue: 'Berkeley TT Club',
      street: '2727 Milvia St',
      city: 'Berkeley',
      region: 'CA',
      postal: '94703',
      country: 'USA',
    },
    ...overrides,
  }
}
