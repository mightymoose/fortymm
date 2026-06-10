import { buildPlayerProfileView } from "./player-profile.factory";
import type { PlayersPanelDisplayProps } from "./players-panel-display";
import type { PlayersPanelView } from "./players-panel-query";
import { buildRookieCareerStatsView } from "./career-stats.factory";
import { buildUnratedRatingBoxView } from "./rating-box.factory";
import { buildEmptyRecentFormView } from "./recent-form.factory";

/** A first-match rookie profile — unrated, empty form, no career numbers. */
export function buildRookiePlayerProfileView(
  overrides: Partial<ReturnType<typeof buildPlayerProfileView>> = {},
) {
  return buildPlayerProfileView({
    name: "leo.mertens",
    initials: "LM",
    rating: buildUnratedRatingBoxView(),
    form: buildEmptyRecentFormView(),
    career: buildRookieCareerStatsView(),
    ...overrides,
  });
}

/** A live match's snapshot: rita.kovac (rated, 1–1 form, 12-match career)
 * against first-timer leo.mertens. */
export function buildPlayersPanelView(
  overrides: Partial<PlayersPanelView> = {},
): PlayersPanelView {
  return {
    snapshotLabel: "SNAPSHOT · 8 JUN, 12:00",
    left: buildPlayerProfileView(),
    right: buildRookiePlayerProfileView(),
    ...overrides,
  };
}

/** Props for `PlayersPanelDisplay`. */
export function buildPlayersPanelDisplayProps(
  overrides: Partial<PlayersPanelDisplayProps> = {},
): PlayersPanelDisplayProps {
  return { panel: buildPlayersPanelView(), ...overrides };
}
