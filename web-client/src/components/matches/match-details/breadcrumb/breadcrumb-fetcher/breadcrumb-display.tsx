import { Link } from "@tanstack/react-router";

import type { BreadcrumbTournamentView } from "./breadcrumb-query";

export interface BreadcrumbDisplayProps {
  matchId: string;
  /** `null` for a casual match, or when the viewer can't see this fixture's
   * tournament yet — the breadcrumb then renders exactly as it did before
   * #1288 (AC #8). */
  tournament: BreadcrumbTournamentView | null;
}

/** The match-details header breadcrumb: "Matches › Match abc123", or
 * "Matches › {tournament} › Match abc123" for a match born from a tournament
 * fixture. */
export function BreadcrumbDisplay({ matchId, tournament }: BreadcrumbDisplayProps) {
  return (
    <div className="md-breadcrumb">
      <Link to="/matches">Matches</Link>
      <span>›</span>
      {tournament && (
        <>
          <Link
            to="/tournaments/$tournamentId"
            params={{ tournamentId: tournament.tournamentId }}
          >
            {tournament.tournamentName}
          </Link>
          <span>›</span>
        </>
      )}
      <span className="md-breadcrumb__current">Match {matchId.slice(0, 6)}</span>
    </div>
  );
}
