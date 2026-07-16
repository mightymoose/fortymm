import type { BoardEmptyProps } from './board-empty'

/** Props for `BoardEmpty` — the owner's view (the run-the-scheduler prompt). */
export function buildBoardEmptyProps(
  overrides: Partial<BoardEmptyProps> = {},
): BoardEmptyProps {
  return { canEdit: true, ...overrides }
}
