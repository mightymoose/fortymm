import {
  matchDetailsQuery,
  type MatchDetailsResult,
} from "../../match-details-query";

/** The header's "Score" CTA target: the match + current game to send the
 * viewer to the score-entry route. Null from the query means there's nothing
 * to score right now (the viewer can't score, or there's no current game) and
 * the CTA doesn't render. */
export type ScoreCtaView = {
  matchId: string;
  /** The game the "Score" button deep-links to — the match's current game. */
  gameNumber: number;
};

const selectScoreCta = (match: MatchDetailsResult): ScoreCtaView | null => {
  const details = match.unmigrated;
  // The backend gates `can_score` on participation + an open, scorable game;
  // `current_game` is the slot the button deep-links to. Both must be present.
  if (!details.can_score || !details.current_game) return null;
  return {
    matchId: details.id,
    gameNumber: details.current_game.game_number,
  };
};

export const scoreCtaQuery = (matchId: string) => ({
  ...matchDetailsQuery(matchId),
  select: selectScoreCta,
});
