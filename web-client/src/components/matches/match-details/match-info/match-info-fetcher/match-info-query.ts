import {
  matchDetailsQuery,
  type MatchDetailsResult,
} from "../../match-details-query";

/** One label/value line in the match-info card, e.g. "Status" / "Live". */
export type InfoRowView = {
  label: string;
  value: string;
};

/** The "Match info" sidebar card: a fixed run of label/value rows — format,
 * status, and whether the match is rated. All label text is derived here. */
export type MatchInfoView = {
  rows: InfoRowView[];
};

const selectMatchInfo = (match: MatchDetailsResult): MatchInfoView => {
  const details = match.unmigrated;
  const teamLabel = details.team_size === 1 ? "Singles" : "Doubles";
  // A best-of-1 match is a single game, so drop the "Best of N, first to M"
  // race framing that only makes sense for a multi-game set.
  const formatValue =
    details.best_of === 1
      ? `${teamLabel} · Single game`
      : `${teamLabel} · Best of ${details.best_of}, first to ${details.games_to_win}`;
  return {
    rows: [
      {
        label: "Format",
        value: formatValue,
      },
      { label: "Status", value: details.status_label },
      { label: "Rated", value: details.affects_rating ? "Yes" : "No" },
    ],
  };
};

export const matchInfoQuery = (matchId: string) => ({
  ...matchDetailsQuery(matchId),
  select: selectMatchInfo,
});
