import { interactiveElementsIn } from '@/test/read-only'
import { fireEvent, render, screen, type Container } from '@/test/utilities'

import { SolveStrip, type SolveStripProps } from './solve-strip'
import { buildSolveStripProps } from './solve-strip.factory'

/** The strip's five designed states, addressed by the testid each renders under. */
export type SolveStripStateId =
  | 'none'
  | 'solving'
  | 'succeeded'
  | 'infeasible'
  | 'failed'

const text = (el: HTMLElement) => (el.textContent ?? '').replace(/\s+/g, ' ').trim()

const scoped = (container: Container) => ({
  /** The whole strip — the scope a read-only guard sweeps. */
  getStrip() {
    return container.getByTestId('solve-strip')
  },

  /** One designed state's block — present iff the strip is in that state. */
  queryState(state: SolveStripStateId) {
    return container.queryByTestId(`solve-strip-${state}`)
  },
  getState(state: SolveStripStateId) {
    return container.getByTestId(`solve-strip-${state}`)
  },
  /** A state's whole copy as one squashed string, for asserting the words. */
  getStateText(state: SolveStripStateId) {
    return text(container.getByTestId(`solve-strip-${state}`))
  },

  /** The owner's Run-scheduler button — absent for a viewer (ADR-0015). */
  getRunButton() {
    return container.getByTestId('run-scheduler') as HTMLButtonElement
  },
  queryRunButton() {
    return container.queryByTestId('run-scheduler')
  },
  clickRun() {
    fireEvent.click(container.getByTestId('run-scheduler'))
  },

  /** The inline refusal (the strip's only error surface — there is no toast). */
  queryNotice() {
    return container.queryByTestId('run-scheduler-notice')
  },
  getNoticeText() {
    return text(container.getByTestId('run-scheduler-notice'))
  },

  /** EVERY interactive control in the strip — the "a viewer is offered nothing"
   * sweep (ADR-0015: no control at all, not a disabled one). */
  getControls() {
    return interactiveElementsIn(container.getByTestId('solve-strip'))
  },
})

/**
 * Test page-object for `SolveStrip`.
 *
 * The strip is presentational: the solve arrives as a prop and the run goes out
 * through `onRun`, so rendering fetches nothing and a refusal test drives the
 * inline notice by handing it an `onRun` that rejects with the `ApiError` shape
 * the mutation would.
 */
export const solveStripPage = {
  render(overrides: Partial<SolveStripProps> = {}) {
    render(<SolveStrip {...buildSolveStripProps(overrides)} />)
  },

  ...scoped(screen),
}
