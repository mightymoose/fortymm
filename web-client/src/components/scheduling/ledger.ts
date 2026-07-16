// The ledger table's designed vocabulary — pure functions from a ledger row to
// the words and tones the admin page renders, so they are unit-tested rather
// than asserted through a DOM (the `../tournaments/data/solve.ts` shape).
//
// Raw API strings never reach the UI (`DEFINITION_OF_COMPLETE.md`): status and
// verdict render through the copy below — which REUSES the solve strip's
// vocabulary (`VERDICT_LABEL`, the strip's state language) rather than minting
// a second dialect — and the one wire sentence that survives is a `failed`
// run's `error`, shown as detail in the expansion because it is the actionable
// content (the strip's own precedent).

import {
  VERDICT_LABEL,
  type ScheduleSolveStatus,
  type SolverVerdict,
} from '@/components/tournaments/data/solve'

/** The tones the table's status chip can take — each maps onto a design token
 * the page styles with (`--fg-3`, `--ball-500`, `--serve-500`, `--warn`,
 * `--loss`), mirroring the strip's tints for the same states. */
export type SolveChipTone = 'muted' | 'accent' | 'ok' | 'warn' | 'loss'

/** What the status/verdict cell renders: the chip's designed label + tone, and
 * — only for a succeeded run — the verdict in the strip's own words
 * (`VERDICT_LABEL`) as the quieter line under it. */
export interface SolveChip {
  label: string
  tone: SolveChipTone
  /** `VERDICT_LABEL` copy for a succeeded run, `null` otherwise — a verdict is
   * only a claim about a plan that exists. */
  verdict: string | null
}

/**
 * Reduce a ledger row's status + verdict to the chip. Total over the status
 * enum — a status added to the API is a compile error here (the parse in
 * `./queries.ts` already refused it at runtime) — and `infeasible` is its own
 * designed arm, never folded into `failed`: the solver *proved* the day does
 * not fit, which is the point of pre-live solves, not a malfunction.
 *
 * A `succeeded` row whose verdict is missing degrades to `feasible` — the
 * modest claim — exactly as the strip does (`solveStripState`).
 */
export function solveChip(
  status: ScheduleSolveStatus,
  verdict: SolverVerdict | null,
): SolveChip {
  switch (status) {
    case 'queued':
      return { label: 'Queued', tone: 'muted', verdict: null }
    case 'running':
      return { label: 'Solving', tone: 'accent', verdict: null }
    case 'succeeded':
      return {
        label: 'Solved',
        tone: 'ok',
        verdict: VERDICT_LABEL[verdict === 'optimal' ? 'optimal' : 'feasible'],
      }
    case 'infeasible':
      return { label: "Doesn't fit", tone: 'warn', verdict: null }
    case 'failed':
      return { label: 'Failed', tone: 'loss', verdict: null }
    default: {
      const exhaustive: never = status
      return exhaustive
    }
  }
}

/** True for the rows that carry a story worth expanding — the two terminal
 * not-a-plan outcomes. The expansion holds the failure detail: the server's
 * `error` sentence (failed only) and the drift guard's `input_fingerprint`. */
export function hasFailureDetail(status: ScheduleSolveStatus): boolean {
  return status === 'failed' || status === 'infeasible'
}

/** The expansion's designed headline — the strip's language for the same two
 * states, so the admin page and the Schedule tab tell one story. */
export const FAILURE_HEADLINE: Record<'failed' | 'infeasible', string> = {
  failed: 'The scheduler hit a problem',
  infeasible: "The day doesn't fit",
}

/** The apply counts, human-sized: `9 placed · 2 pinned`. `null` (a stage not
 * reached) renders as nothing — the caller shows an em-dash. The two move
 * together (both written by the guarded apply), so one null means both. */
export function fmtFixtureCounts(
  placed: number | null,
  pinned: number | null,
): string | null {
  if (placed === null || pinned === null) return null
  return `${placed} placed · ${pinned} pinned`
}
