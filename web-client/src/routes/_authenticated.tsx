import { createFileRoute, notFound } from '@tanstack/react-router'
import { sessionQuery } from '../api/queries'
import { LoadingScreen, MIN_SHOWN_MS, SHOW_AFTER_MS } from '../components/LoadingScreen'

// A pathless layout route for the pages that will need a signed-in user. It
// adds no path segment. Public pages go directly under the root route.
//
// The loader waits for the session, so the router shows the page only once
// the session has started and the page's chunk has loaded. Until then it
// shows the loading screen, if the wait passes SHOW_AFTER_MS, and keeps it
// for at least MIN_SHOWN_MS. The loader stays in the entry chunk, so the
// session starts while the page's chunk downloads. The session never goes
// stale, so later visits find it at once and show no loading screen.
//
// A preload, on a link's hover or focus, never starts the session. On a
// public page such as /signed-out, that would make a guest account the
// visitor never asked for. The router drops a preload's notFound() quietly,
// and the click loads the route as usual.
export const Route = createFileRoute('/_authenticated')({
  beforeLoad: ({ preload, context: { api, queryClient } }) => {
    if (preload && queryClient.getQueryData(sessionQuery(api).queryKey) === undefined) throw notFound()
  },
  loader: async ({ context: { api, queryClient } }) => {
    await queryClient.ensureQueryData(sessionQuery(api))
  },
  pendingComponent: LoadingScreen,
  pendingMs: SHOW_AFTER_MS,
  pendingMinMs: MIN_SHOWN_MS,
})
