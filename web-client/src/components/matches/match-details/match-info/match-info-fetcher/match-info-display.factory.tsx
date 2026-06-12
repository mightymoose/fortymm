import { buildInfoRowView } from "./match-info-display/info-row.factory";
import type { MatchInfoDisplayProps } from "./match-info-display";
import type { MatchInfoView } from "./match-info-query";

/** The info card of a scheduled, rated best-of-5 singles match. */
export function buildMatchInfoView(
  overrides: Partial<MatchInfoView> = {},
): MatchInfoView {
  return {
    rows: [
      buildInfoRowView(),
      buildInfoRowView({ label: "Status", value: "Scheduled" }),
      buildInfoRowView({ label: "Rated", value: "Yes" }),
    ],
    ...overrides,
  };
}

/** Props for `MatchInfoDisplay`. */
export function buildMatchInfoDisplayProps(
  overrides: Partial<MatchInfoDisplayProps> = {},
): MatchInfoDisplayProps {
  return { info: buildMatchInfoView(), ...overrides };
}
