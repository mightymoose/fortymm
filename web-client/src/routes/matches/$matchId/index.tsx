import { createFileRoute } from '@tanstack/react-router'
import { MatchDetails } from '../../../components/MatchDetails.tsx'

// /matches/<id>: the match's details page. The layout above ($matchId.tsx)
// reads the match into the match store, or gives not found for a match not
// on this device, so this route has no loader of its own.
export const Route = createFileRoute('/matches/$matchId/')({
  component: MatchDetailsRoute,
})

function MatchDetailsRoute() {
  const { matchId } = Route.useParams()
  return <MatchDetails matchId={matchId} />
}
