import type { InfoRowProps } from "./info-row";
import type { InfoRowView } from "../match-info-query";

/** The "Format" row of a rated best-of-5 singles match. */
export function buildInfoRowView(
  overrides: Partial<InfoRowView> = {},
): InfoRowView {
  return {
    label: "Format",
    value: "Singles · Best of 5, first to 3",
    ...overrides,
  };
}

/** Props for `InfoRow`. */
export function buildInfoRowProps(
  overrides: Partial<InfoRowProps> = {},
): InfoRowProps {
  return { row: buildInfoRowView(), ...overrides };
}
