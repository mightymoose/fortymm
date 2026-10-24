import { createFileRoute } from '@tanstack/react-router'
import { healthQuery } from '../api/queries'
import { AuthenticatedLayout } from '../pages/AuthenticatedLayout'

// A pathless layout route for the pages that will need a signed-in user. It
// adds no path segment. Public pages go directly under the root route.
export const Route = createFileRoute('/_authenticated')({
  // The loader stays in the entry chunk, so the health check starts while
  // the page's chunk downloads.
  loader: ({ context: { api, queryClient } }) => {
    void queryClient.prefetchQuery(healthQuery(api))
  },
  component: AuthenticatedLayout,
})
