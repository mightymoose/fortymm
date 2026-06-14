import type { StatusBadgeProps, StatusBadgeView } from "./status-badge";

/** A live-status badge with the live tone and pulsing dot. */
export function buildStatusBadgeView(
  overrides: Partial<StatusBadgeView> = {},
): StatusBadgeView {
  return {
    label: "LIVE",
    toneClass: "status-tone-live",
    isLive: true,
    ...overrides,
  };
}

/** Props for `StatusBadge`. */
export function buildStatusBadgeProps(
  overrides: Partial<StatusBadgeProps> = {},
): StatusBadgeProps {
  return {
    status: buildStatusBadgeView(),
    ...overrides,
  };
}
