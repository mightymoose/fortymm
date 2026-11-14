import { createFileRoute, redirect } from '@tanstack/react-router'

// /design-system has no page of its own: it shows the first tab, Colour, at
// that tab's address, so the address always names the tab you see.
export const Route = createFileRoute('/design-system/')({
  beforeLoad: () => {
    throw redirect({ to: '/design-system/colour', replace: true })
  },
})
