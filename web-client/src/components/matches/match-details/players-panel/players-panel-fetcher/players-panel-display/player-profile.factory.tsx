import { buildCareerStatsView } from "./player-profile/career-stats.factory";
import type { PlayerProfileProps } from "./player-profile";
import type { PlayerProfileView } from "../players-panel-query";
import { buildRatingBoxView } from "./player-profile/rating-box.factory";
import { buildHistoryRecentFormView } from "./player-profile/recent-form.factory";

/** rita.kovac going in rated 1612 with a 1–1 recent form over a 12-match,
 * 75%-win-rate career; the match isn't decided, so `won` is false. */
export function buildPlayerProfileView(
  overrides: Partial<PlayerProfileView> = {},
): PlayerProfileView {
  return {
    name: "rita.kovac",
    initials: "RK",
    won: false,
    rating: buildRatingBoxView(),
    form: buildHistoryRecentFormView(),
    career: buildCareerStatsView(),
    ...overrides,
  };
}

/** Props for `PlayerProfile`. */
export function buildPlayerProfileProps(
  overrides: Partial<PlayerProfileProps> = {},
): PlayerProfileProps {
  return { profile: buildPlayerProfileView(), ...overrides };
}
