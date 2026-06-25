import type { DisputeNoticeView } from "./dispute-notice-query";
import type { DisputeNoticeDisplayProps } from "./dispute-notice-display";

/** A disputed result rejected by the opponent "nguyen.t". */
export function buildDisputeNoticeView(
  overrides: Partial<DisputeNoticeView> = {},
): DisputeNoticeView {
  return {
    disputerName: "nguyen.t",
    ...overrides,
  };
}

/** Props for `DisputeNoticeDisplay`. */
export function buildDisputeNoticeDisplayProps(
  overrides: Partial<DisputeNoticeDisplayProps> = {},
): DisputeNoticeDisplayProps {
  return {
    view: buildDisputeNoticeView(),
    ...overrides,
  };
}
