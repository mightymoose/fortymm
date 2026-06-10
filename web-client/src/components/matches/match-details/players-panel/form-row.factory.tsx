import type { FormRowProps } from "./form-row";
import type { FormRowView } from "./players-panel-query";

/** A 3–1 win over silva.r on May 9. */
export function buildFormRowView(
  overrides: Partial<FormRowView> = {},
): FormRowView {
  return {
    matchId: "m-prev-1",
    won: true,
    opponentLabel: "silva.r",
    dateLabel: "May 9",
    scoreLabel: "3–1",
    ...overrides,
  };
}

/** A 1–3 loss to tanaka.y on May 7 — pair with the win for a mixed list. */
export function buildLossFormRowView(
  overrides: Partial<FormRowView> = {},
): FormRowView {
  return buildFormRowView({
    matchId: "m-prev-2",
    won: false,
    opponentLabel: "tanaka.y",
    dateLabel: "May 7",
    scoreLabel: "1–3",
    ...overrides,
  });
}

/** Props for `FormRow`. */
export function buildFormRowProps(
  overrides: Partial<FormRowProps> = {},
): FormRowProps {
  return { result: buildFormRowView(), ...overrides };
}
