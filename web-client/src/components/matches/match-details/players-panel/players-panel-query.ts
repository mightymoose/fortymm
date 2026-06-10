import { fmtDateShort, fmtDateTimeShort } from "@/lib/dates";
import { initialsOf } from "@/lib/utils";

import {
  matchDetailsQuery,
  type MatchDetailsResult,
} from "../match-details-query";
import { orderedSides, type MatchDetailsSide } from "../ordered-sides";

/** One past result in a player's recent-form list. */
export type FormRowView = {
  /** The past match's id — used as the list key; rows don't link anywhere. */
  matchId: string;
  won: boolean;
  /** That match's opponent username, or "No opponent" when it had none. */
  opponentLabel: string;
  /** When the past match completed, e.g. "May 9". */
  dateLabel: string;
  /** Player-perspective games line, e.g. "3–1". */
  scoreLabel: string;
};

/** The form block in the middle of a profile: the first-match sentence when
 * the player has no history, otherwise a W–L kicker, a one-line career
 * summary, and the recent result rows. */
export type RecentFormView =
  | {
      kind: "empty";
      /** e.g. "No prior matches yet — this is your first one." — "your" for
       * the viewer's own side, "their" otherwise. */
      emptyText: string;
    }
  | {
      kind: "history";
      /** W–L over the recent results shown, e.g. "Form · 3–2". */
      kicker: string;
      /** Career numbers, e.g. "8 prior matches · 75% win rate going in". */
      summary: string;
      rows: FormRowView[];
    };

/** The pre-match rating box at the top of a profile. */
export type RatingBoxView = {
  /** Rounded pre-match rating; null renders as "Unrated". */
  value: number | null;
  /** Rating history for the sparkline; null when there aren't at least two
   * points to draw a line through. */
  sparkline: number[] | null;
};

/** The career strip at the bottom of a profile. */
export type CareerStatsView = {
  /** Career matches completed before this one. */
  matches: number;
  /** e.g. "75%"; null renders as the dim em dash (no career matches yet). */
  winRateLabel: string | null;
  /** True at a 50%+ win rate — drives the green highlight. */
  highWinRate: boolean;
};

/** One player's half of the snapshot panel. */
export type PlayerProfileView = {
  name: string;
  initials: string;
  /** True only when this side has won the match — picks the avatar tone. */
  won: boolean;
  rating: RatingBoxView;
  form: RecentFormView;
  career: CareerStatsView;
};

/** The "Players · going into this match" panel. Sides are perspective-ordered
 * like the scoreboard: the viewer's side reads left when they're a
 * participant, otherwise side 1 is left. A null side is a missing opponent —
 * no second side, or a playerless ghost side — rendered as the "No opponent"
 * placeholder. */
export type PlayersPanelView = {
  /** When these numbers were captured (match creation),
   * e.g. "SNAPSHOT · 8 JUN, 12:00". */
  snapshotLabel: string;
  left: PlayerProfileView | null;
  right: PlayerProfileView | null;
};

type MatchDetailsPlayerForm = NonNullable<
  MatchDetailsResult["unmigrated"]["recent_form"]
>[number];
type MatchDetailsFormResult = MatchDetailsPlayerForm["recent_results"][number];

// A player the API returned no form entry for has no history at all — the
// projection below then lands on the empty/Unrated/em-dash branches.
const EMPTY_FORM: MatchDetailsPlayerForm = {
  user_id: "",
  recent_results: [],
  rating_before: null,
  rating_history: [],
  career_matches_before: 0,
  career_wins_before: 0,
};

const careerWinRate = (form: MatchDetailsPlayerForm): number | null =>
  form.career_matches_before > 0
    ? Math.round((form.career_wins_before / form.career_matches_before) * 100)
    : null;

const selectFormRow = (result: MatchDetailsFormResult): FormRowView => ({
  matchId: result.match_id,
  won: result.is_win,
  opponentLabel: result.opponent_username ?? "No opponent",
  dateLabel: fmtDateShort(result.completed_at),
  scoreLabel: `${result.player_games_won}–${result.opponent_games_won}`,
});

const selectRecentForm = (
  form: MatchDetailsPlayerForm,
  isCurrentUser: boolean,
): RecentFormView => {
  const results = form.recent_results;
  if (results.length === 0) {
    return {
      kind: "empty",
      emptyText: `No prior matches yet — this is ${isCurrentUser ? "your" : "their"} first one.`,
    };
  }
  const wins = results.filter((r) => r.is_win).length;
  const losses = results.length - wins;
  // A one-line "going in" summary so the with-history half leads with a
  // sentence, mirroring the empty half's "first one" line.
  const matches = form.career_matches_before;
  const winRate = careerWinRate(form);
  return {
    kind: "history",
    kicker: `Form · ${wins}–${losses}`,
    summary:
      `${matches} prior ${matches === 1 ? "match" : "matches"}` +
      (winRate !== null ? ` · ${winRate}% win rate going in` : ""),
    rows: results.map(selectFormRow),
  };
};

const selectProfile = (
  side: MatchDetailsSide | null,
  details: MatchDetailsResult["unmigrated"],
): PlayerProfileView | null => {
  const player = side?.players[0];
  if (!side || !player) return null;
  const form =
    details.recent_form?.find((f) => f.user_id === player.user_id) ??
    EMPTY_FORM;
  const history = form.rating_history ?? [];
  const winRate = careerWinRate(form);
  return {
    name: player.username,
    initials: initialsOf(player.username),
    won: side.won === true,
    rating: {
      value: form.rating_before == null ? null : Math.round(form.rating_before),
      sparkline: history.length >= 2 ? history : null,
    },
    form: selectRecentForm(form, side.is_current_user_side),
    career: {
      matches: form.career_matches_before,
      winRateLabel: winRate === null ? null : `${winRate}%`,
      highWinRate: winRate !== null && winRate >= 50,
    },
  };
};

const selectPlayersPanel = (match: MatchDetailsResult): PlayersPanelView => {
  const details = match.unmigrated;
  const [first, second] = orderedSides(details);
  return {
    snapshotLabel: `SNAPSHOT · ${fmtDateTimeShort(details.created_at).toUpperCase()}`,
    left: selectProfile(first, details),
    right: selectProfile(second, details),
  };
};

export const playersPanelQuery = (matchId: string) => ({
  ...matchDetailsQuery(matchId),
  select: selectPlayersPanel,
});
