import { createFileRoute, notFound } from '@tanstack/react-router'
import { Match } from '../../components/Match.tsx'
import { matchStore } from '../../stores/match.ts'

// The layout route of every page of one match (matches/$matchId/*). Its
// loader reads the match into the match store, once for every page of it; a
// match not on this device is not found. Matches are kept in memory for now
// (stores/match-memory.ts), so a reload gives not found too (the user's
// decision). A match the device won't read is no error here: the layout
// (Match) says so in place of the page, and reads it again.
export const Route = createFileRoute('/matches/$matchId')({
  loader: async ({ params }) => {
    const entry = await matchStore.getState().load(params.matchId)
    if (entry.status === 'missing') throw notFound()
  },
  component: MatchRoute,
})

function MatchRoute() {
  const { matchId } = Route.useParams()
  return <Match matchId={matchId} />
}
