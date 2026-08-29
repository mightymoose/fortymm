import {
  matchDetailsQuery,
  type MatchDetailsResult,
} from "../../match-details-query";

/**
 * The match page's "why can't I score this yet" banner (#1288) — a
 * discriminated projection of `not_scorable_reason` + `tournament` (both
 * parsed at the boundary by `matchDetailsQuery`, see `match-details-query.ts`).
 *
 * `kind: "none"` means the banner doesn't render at all: either the match is
 * genuinely scorable right now, or — the casual-match case — there's simply
 * nothing to say. A spectator on an otherwise-callable match also lands here
 * (`not_scorable_reason` is `null` for them too; `can_score` is a *separate*,
 * viewer-relative flag this view intentionally ignores — see the scorable/
 * spectator distinction in web-client/CLAUDE.md).
 */
export type CallStatusView =
  | { kind: "none" }
  | {
      /** `not_called`, tournament visible, but the tournament hasn't gone
       * live yet — a placement (if any) is silent, not a promise of an
       * imminent call. */
      kind: "awaiting_placement";
      tournamentName: string;
      /** The event this fixture belongs to within the tournament (#1288 AC
       * #2 — the match page must name the event, not just the tournament). */
      eventName: string;
      /** The table the director placed this fixture on, or `null` until
       * placed. Naming it is a statement of fact, never a "you'll be called
       * soon" promise — the copy at the display layer must keep that
       * distinction. */
      tableLabel: string | null;
    }
  | {
      /** `not_called`, tournament visible and live: the fixture is waiting
       * to be called. `canEdit` decides whether the viewer gets a link into
       * the tournament — ADR-0015: a control a non-owner can't use is
       * hidden, never disabled. */
      kind: "awaiting_call";
      tournamentId: string;
      tournamentName: string;
      /** The event this fixture belongs to within the tournament (#1288 AC
       * #2 — the match page must name the event, not just the tournament). */
      eventName: string;
      canEdit: boolean;
    }
  | {
      /** `not_called`, but the viewer can't see this tournament yet (a draft
       * tournament, non-owner/anonymous viewer) — generic copy, no
       * tournament name leaked. */
      kind: "awaiting_call_hidden";
    }
  | {
      /** A result has been posted; the scratchpad is frozen. Distinct copy
       * from the "not called" cases — never describe this as "not called". */
      kind: "result_posted";
    }
  | {
      /** No opponent yet, or a terminal/other non-scorable state — generic
       * copy, no promise of anything. */
      kind: "not_scorable";
      reason: "no_opponent" | "not_scorable";
    };

const selectCallStatus = (match: MatchDetailsResult): CallStatusView => {
  const reason = match.not_scorable_reason;
  if (reason === null) return { kind: "none" };
  if (reason === "result_posted") return { kind: "result_posted" };
  if (reason === "no_opponent" || reason === "not_scorable") {
    return { kind: "not_scorable", reason };
  }
  // reason === "not_called"
  const tournament = match.tournament;
  if (!tournament) return { kind: "awaiting_call_hidden" };
  if (tournament.tournament_status !== "live") {
    return {
      kind: "awaiting_placement",
      tournamentName: tournament.tournament_name,
      eventName: tournament.event_name,
      tableLabel: tournament.table_label,
    };
  }
  return {
    kind: "awaiting_call",
    tournamentId: tournament.tournament_id,
    tournamentName: tournament.tournament_name,
    eventName: tournament.event_name,
    canEdit: tournament.can_edit,
  };
};

export const callStatusQuery = (matchId: string) => ({
  ...matchDetailsQuery(matchId),
  select: selectCallStatus,
});
