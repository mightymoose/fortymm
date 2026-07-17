import type { SolveStripProps } from './solve-strip'

/** Props for `SolveStrip` — by default the state every tournament is born in: no
 * solve ever requested (`solve: null`), seen by the owner. A test that wants a
 * ledger row on the strip passes a `buildScheduleSolve(...)` override
 * (`../data/seed.factory`); one that wants the viewer passes `canEdit: false`.
 * `onRun` resolves by default — a refusal test overrides it with a rejection
 * carrying the `ApiError` the strip must word. */
export function buildSolveStripProps(
  overrides: Partial<SolveStripProps> = {},
): SolveStripProps {
  return {
    solve: null,
    canEdit: true,
    onRun: () => Promise.resolve(),
    ...overrides,
  }
}
