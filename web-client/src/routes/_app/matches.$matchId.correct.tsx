import { createFileRoute } from "@tanstack/react-router";
import { CorrectionEntry } from "@/components/matches/correction-entry/correction-entry";
import { MatchDetailsError } from "@/components/matches/match-details";
import { ApiError } from "@/api/client";
import { pageTitle } from "@/lib/page-title";
import { isMatchId } from "@/lib/match-id";

export const Route = createFileRoute("/_app/matches/$matchId/correct")({
  head: () => ({
    meta: [{ title: pageTitle("Suggest a correction") }],
  }),
  component: CorrectionRoute,
  // `CorrectionEntry` fetches the match with `throwOnError`, so a 404 (no such
  // match) or 422 (malformed id) throws during render. Reuse the match-details
  // fallback so it maps to the same friendly "We couldn't find that match."
  // dead end instead of TanStack's generic crash page (#385).
  errorComponent: MatchDetailsError,
});

function CorrectionRoute() {
  const { matchId } = Route.useParams();
  if (!isMatchId(matchId)) {
    // Reject a malformed id without hitting the API — same friendly not-found
    // UI, no 422 and no console-noise `ApiError` (#385).
    return (
      <MatchDetailsError
        error={new ApiError(404, null, `load match ${matchId}`)}
        reset={() => {}}
      />
    );
  }
  return <CorrectionEntry matchId={matchId} />;
}
