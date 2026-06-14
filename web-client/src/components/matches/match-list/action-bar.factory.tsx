import type { ActionBarProps } from "./action-bar";

/** The action bar with 3 live matches and an unfiltered export link. */
export function buildActionBarProps(
  overrides: Partial<ActionBarProps> = {},
): ActionBarProps {
  return {
    liveCount: 3,
    exportHref: "https://example.test/v1/matches.csv",
    ...overrides,
  };
}
