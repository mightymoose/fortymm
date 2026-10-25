import { createFileRoute, notFound } from '@tanstack/react-router'
import { isVariantSlug } from '../../../../pages/players/variantSlugs'

// One mockup of the players list, such as `/players/table`. An unknown
// mockup is the app's not-found page.
export const Route = createFileRoute('/_authenticated/players/$variant')({
  beforeLoad: ({ params }) => {
    if (!isVariantSlug(params.variant)) throw notFound()
  },
})
