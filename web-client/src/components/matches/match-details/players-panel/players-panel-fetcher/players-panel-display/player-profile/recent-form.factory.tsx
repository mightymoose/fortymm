import {
  buildFormRowView,
  buildLossFormRowView,
} from "./recent-form/form-row.factory";
import type {
  RecentFormView,
} from "../../players-panel-query";
import type { RecentFormProps } from "./recent-form";

/** A 1–1 recent form over a 12-match, 75%-win-rate career. */
export function buildHistoryRecentFormView(
  overrides: Partial<Extract<RecentFormView, { kind: "history" }>> = {},
): RecentFormView {
  return {
    kind: "history",
    kicker: "Form · 1–1",
    summary: "12 prior matches · 75% win rate going in",
    rows: [buildFormRowView(), buildLossFormRowView()],
    ...overrides,
  };
}

/** The first-match empty state, addressed to a non-viewer side. */
export function buildEmptyRecentFormView(
  overrides: Partial<Extract<RecentFormView, { kind: "empty" }>> = {},
): RecentFormView {
  return {
    kind: "empty",
    emptyText: "No prior matches yet — this is their first one.",
    ...overrides,
  };
}

/** Props for `RecentForm` — the with-history scenario. */
export function buildRecentFormProps(
  overrides: Partial<RecentFormProps> = {},
): RecentFormProps {
  return { form: buildHistoryRecentFormView(), ...overrides };
}
