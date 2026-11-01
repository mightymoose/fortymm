export const TESTFLIGHT_URL = 'https://testflight.apple.com/join/5pGVbku3'

// Each mobile beta the account menu links to, below 900px. `label` is the
// visible text and sits inside `name`, the accessible name, so speech input
// finds the link by what it shows.
export const mobileApps: readonly {
  name: string
  label: string
  href: string
}[] = [
  { name: 'Get the iPhone app', label: 'iPhone app', href: TESTFLIGHT_URL },
]
