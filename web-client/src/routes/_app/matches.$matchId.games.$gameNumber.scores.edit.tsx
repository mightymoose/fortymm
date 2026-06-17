import { createFileRoute } from '@tanstack/react-router'
import { ScoreEntry } from '@/components/matches/score-entry'
import { MatchDetailsError } from '@/components/matches/match-details'
import { ApiError } from '@/api/client'
import { pageTitle } from '@/lib/page-title'
import { isMatchId } from '@/lib/match-id'

export const Route = createFileRoute(
  '/_app/matches/$matchId/games/$gameNumber/scores/edit',
)({
  head: () => ({
    meta: [{ title: pageTitle('Edit score') }],
  }),
  component: ScoreEditRoute,
  // `ScoreEntry` fetches the match with `throwOnError`, so a 404 (no such
  // match) or 422 (malformed id) on `GET /v1/matches/{id}` throws during
  // render. Without a boundary that escaped to TanStack's generic "Something
  // went wrong!" crash page (#385); reuse the match-details fallback so it maps
  // to the same friendly "We couldn't find that match." dead end instead.
  errorComponent: MatchDetailsError,
})

function ScoreEditRoute() {
  const { matchId, gameNumber } = Route.useParams()
  if (!isMatchId(matchId)) {
    // Reject a malformed id without ever hitting the API — same friendly
    // not-found UI, no 422 and no console-noise `ApiError` (#385).
    return (
      <MatchDetailsError
        error={new ApiError(404, null, `load match ${matchId}`)}
        reset={() => {}}
      />
    )
  }
  return (
    <ScoreEntry
      matchId={matchId}
      gameNumber={Number(gameNumber)}
      mode={{ kind: 'edit' }}
    />
  )
}
