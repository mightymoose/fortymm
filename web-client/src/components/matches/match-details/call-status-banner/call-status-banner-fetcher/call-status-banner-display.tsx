import { Link } from "@tanstack/react-router";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { NOT_SCORABLE_REASON_COPY } from "@/components/matches/not-scorable-reason-copy";

import type { CallStatusView } from "./call-status-banner-query";

export interface CallStatusBannerDisplayProps {
  callStatus: CallStatusView;
}

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
              ? `This ${callStatus.eventName} fixture is placed on ${callStatus.tableLabel} in ${callStatus.tournamentName}, but the tournament hasn't gone live yet.`
              : `This match is part of ${callStatus.eventName} in ${callStatus.tournamentName}, which hasn't gone live yet.`}
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
                This {callStatus.eventName} fixture is waiting to be called to
                a table.{" "}
                <Link
                  to="/tournaments/$tournamentId"
                  params={{ tournamentId: callStatus.tournamentId }}
                >
                  Open the tournament
                </Link>{" "}
                to call it from the Schedule tab.
              </>
            ) : (
              `This ${callStatus.eventName} fixture is waiting for the tournament director to call it to a table.`
            )}
          </AlertDescription>
        </Alert>
      );
    case "awaiting_call_hidden":
      return (
        <Alert>
          <AlertTitle>Not yet scorable</AlertTitle>
          <AlertDescription>
            {NOT_SCORABLE_REASON_COPY.not_called}
          </AlertDescription>
        </Alert>
      );
    case "result_posted":
      return (
        <Alert>
          <AlertTitle>Result posted</AlertTitle>
          <AlertDescription>
            {NOT_SCORABLE_REASON_COPY.result_posted}
          </AlertDescription>
        </Alert>
      );
    case "not_scorable":
      return (
        <Alert>
          <AlertTitle>Not yet scorable</AlertTitle>
          <AlertDescription>
            {NOT_SCORABLE_REASON_COPY[callStatus.reason]}
          </AlertDescription>
        </Alert>
      );
  }
}
