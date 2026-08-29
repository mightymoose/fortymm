import type { BreadcrumbDisplayProps } from "./breadcrumb-display";

/** Props for `BreadcrumbDisplay` — a casual match by default (no tournament
 * crumb), matching the pre-#1288 breadcrumb. */
export function buildBreadcrumbDisplayProps(
  overrides: Partial<BreadcrumbDisplayProps> = {},
): BreadcrumbDisplayProps {
  return {
    matchId: "abcdef0000",
    tournament: null,
    ...overrides,
  };
}
