import { Link } from "@tanstack/react-router";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

import type { CallStatusView } from "./call-status-banner-query";

export interface CallStatusBannerDisplayProps {
  callStatus: CallStatusView;
}

/** Copy for the two reasons that get no richer, tournament-aware treatment —
 * mirrors `ensure_scorable`'s messages (api/app/match_scoring.py) so the
 * banner never contradicts what the write path would have said. */
const NOT_SCORABLE_COPY: Record<"no_opponent" | "not_scorable", string> = {
  no_opponent: "This match has no opponent and can't be scored.",
  not_scorable: "This match is no longer scorable.",
};

/**
 * The match page's "why can't I score this yet" banner (#1288). Renders
 * nothing for `kind: "none"` — a scorable match, or a casual match with
 * nothing to say (AC #6).
 */
export function CallStatusBannerDisplay({
  callStatus,
}: CallStatusBannerDisplayProps) {
  if (callStatus.kind === "none") return null;

  switch (callStatus.kind) {
    case "awaiting_placement":
      return (
        <Alert>
          <AlertTitle>Not yet scorable</AlertTitle>
          <AlertDescription>
            {callStatus.tableLabel
              ? `This fixture is placed on ${callStatus.tableLabel} in ${callStatus.tournamentName}, but the tournament hasn't gone live yet.`
              : `This match is part of ${callStatus.tournamentName}, which hasn't gone live yet.`}
          </AlertDescription>
        </Alert>
      );
    case "awaiting_call":
      return (
        <Alert>
          <AlertTitle>Waiting to be called</AlertTitle>
          <AlertDescription>
            {callStatus.canEdit ? (
              <>
                This fixture is waiting to be called to a table.{" "}
                <Link
                  to="/tournaments/$tournamentId"
                  params={{ tournamentId: callStatus.tournamentId }}
                >
                  Open the tournament
                </Link>{" "}
                to call it from the Schedule tab.
              </>
            ) : (
              "This fixture is waiting for the tournament director to call it to a table."
            )}
          </AlertDescription>
        </Alert>
      );
    case "awaiting_call_hidden":
      return (
        <Alert>
          <AlertTitle>Not yet scorable</AlertTitle>
          <AlertDescription>
            This match hasn't been called to a table yet.
          </AlertDescription>
        </Alert>
      );
    case "result_posted":
      return (
        <Alert>
          <AlertTitle>Result posted</AlertTitle>
          <AlertDescription>
            This match has a posted result; scores are frozen.
          </AlertDescription>
        </Alert>
      );
    case "not_scorable":
      return (
        <Alert>
          <AlertTitle>Not yet scorable</AlertTitle>
          <AlertDescription>
            {NOT_SCORABLE_COPY[callStatus.reason]}
          </AlertDescription>
        </Alert>
      );
  }
}
