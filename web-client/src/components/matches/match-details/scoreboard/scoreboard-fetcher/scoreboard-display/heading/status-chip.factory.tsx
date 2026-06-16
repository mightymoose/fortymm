import type { StatusChipView } from "../../scoreboard-query";
import type { StatusChipProps } from "./status-chip";

/** The projected chip view the status chip renders. */
export function buildStatusChipView(
  overrides: Partial<StatusChipView> = {},
): StatusChipView {
  return {
    status: "final",
    label: "Final",
    ...overrides,
  };
}

/** Props for `StatusChip`. */
export function buildStatusChipProps(
  overrides: Partial<StatusChipProps> = {},
): StatusChipProps {
  return {
    chip: buildStatusChipView(),
    ...overrides,
  };
}
