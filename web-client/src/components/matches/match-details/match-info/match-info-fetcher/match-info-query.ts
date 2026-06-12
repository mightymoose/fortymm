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
  return {
    rows: [
      {
        label: "Format",
        value: `${details.team_size === 1 ? "Singles" : "Doubles"} · Best of ${details.best_of}, first to ${details.games_to_win}`,
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
