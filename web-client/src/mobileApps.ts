import type { IconName } from './components/Icon'

export const TESTFLIGHT_URL = 'https://testflight.apple.com/join/5pGVbku3'

// Each mobile beta the app shell links to. `label` is the visible text and
// sits inside `name`, the accessible name, so speech input finds the link by
// what it shows.
export const mobileApps: readonly {
  name: string
  label: string
  href: string
  icon: IconName
}[] = [
  { name: 'Get the iPhone app', label: 'iPhone app', href: TESTFLIGHT_URL, icon: 'smartphone' },
]
