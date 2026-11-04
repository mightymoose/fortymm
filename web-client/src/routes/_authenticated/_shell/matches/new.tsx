import { createFileRoute } from '@tanstack/react-router'
import { opponentsQuery, sessionQuery } from '../../../../api/queries'
import { NewMatch } from '../../../../pages/matches/NewMatch'

// The recent opponents start loading with the page's chunk. The page shows
// without waiting for them, and their list has its own skeleton and error.
export const Route = createFileRoute('/_authenticated/_shell/matches/new')({
  loader: async ({ context: { api, queryClient } }) => {
    // The request needs the session's cookie, and the parent's loader runs
    // alongside this one.
    await queryClient.ensureQueryData(sessionQuery(api))
    void queryClient.prefetchQuery(opponentsQuery(api, ''))
  },
  component: NewMatch,
})
