import {
  matchDetailsQuery,
  type MatchDetailsResult,
} from "../../match-details-query";

/** The breadcrumb's tournament crumb — just enough to name and link the
 * tournament a fixture belongs to. `null` for a casual match, or when the
 * viewer can't see the tournament yet (both fold together here: neither
 * gets a crumb). Unconditional on `not_scorable_reason` — a called,
 * already-scorable tournament match still shows its tournament name (#1288
 * AC #2), unlike the richer `callStatusQuery` projection. */
export type BreadcrumbTournamentView = {
  tournamentId: string;
  tournamentName: string;
};

const selectBreadcrumbTournament = (
  match: MatchDetailsResult,
): BreadcrumbTournamentView | null => {
  const tournament = match.tournament;
  if (!tournament) return null;
  return {
    tournamentId: tournament.tournament_id,
    tournamentName: tournament.tournament_name,
  };
};

export const breadcrumbQuery = (matchId: string) => ({
  ...matchDetailsQuery(matchId),
  select: selectBreadcrumbTournament,
});
