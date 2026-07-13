import { interactiveElementsIn } from '@/test/read-only'
import { render, screen, type Container } from '@/test/utilities'

import { DrawPanel, type DrawPanelProps } from './draw-panel'
import { buildDrawPanelProps } from './draw-panel.factory'
import { poolDrawPage } from './draw-panel/pool-draw.page'

const scoped = (container: Container) => ({
  /** The whole panel for one event — the scope a read-only guard sweeps, and the one an
   * Events tab narrows to when several cards are on screen. */
  getPanel(eventId: string) {
    return container.getByTestId(`draw-panel-${eventId}`)
  },
  queryPanel(eventId: string) {
    return container.queryByTestId(`draw-panel-${eventId}`)
  },

  /** **Generate draw** — the director's verb on an event with no draw. Absent for
   * everyone else, and absent (in favour of Re-cut) once a draw exists. */
  queryGenerateButton(eventName: string) {
    return container.queryByRole('button', {
      name: `Generate draw for ${eventName}`,
    })
  },
  findGenerateButton(eventName: string) {
    return container.findByRole('button', {
      name: `Generate draw for ${eventName}`,
    })
  },
  /** **Re-cut draw** — replaces a standing draw wholesale. */
  queryRecutButton(eventName: string) {
    return container.queryByRole('button', { name: `Re-cut draw for ${eventName}` })
  },
  findRecutButton(eventName: string) {
    return container.findByRole('button', { name: `Re-cut draw for ${eventName}` })
  },
  /** **Delete draw** — un-cuts it, and unfreezes the pool set. */
  queryDeleteButton(eventName: string) {
    return container.queryByRole('button', { name: `Delete draw for ${eventName}` })
  },
  findDeleteButton(eventName: string) {
    return container.findByRole('button', { name: `Delete draw for ${eventName}` })
  },

  /** The **designed empty state** of an event with no draw — inert copy, never a
   * spinner and never an error. */
  queryEmptyState() {
    return container.queryByTestId('draw-empty')
  },
  getEmptyState() {
    return container.getByTestId('draw-empty')
  },

  /** The inline **refusal** — the 409, the 422 and every other failure, in the place the
   * click happened. Found by role (`alert`), which is the contract: it is the app talking
   * back, and a screen reader must hear it without hunting for it. */
  queryNotice() {
    return container.queryByRole('alert')
  },
  findNotice() {
    return container.findByRole('alert')
  },
  /** The notice as one normalised string — title *and* the sentence beneath it, since
   * the whole point of the 409/422 copy is that both halves are there. */
  async findNoticeText() {
    const notice = await container.findByRole('alert')
    return (notice.textContent ?? '').replace(/\s+/g, ' ').trim()
  },

  /** EVERY control in the panel. The sweep a "a non-owner is offered nothing" claim
   * actually needs: the named accessors above would miss a button that was renamed or
   * left unlabelled, and "no *enabled* button" is not the assertion — "no button at
   * all" is (ADR-0015: hide the affordance, never disable it). */
  getPanelControls(eventId: string) {
    return interactiveElementsIn(container.getByTestId(`draw-panel-${eventId}`))
  },

  /** The un-pooled group — fixtures belonging to no pool. Empty today (round-robin is
   * the only draw type with a generator), but never *dropped*. */
  queryUnpooled() {
    return container.queryByTestId('draw-unpooled')
  },

  // Pools, rounds and fixture lines come from the child page objects.
  ...poolDrawPage.within(container),
})

/**
 * Test page-object for `DrawPanel`.
 *
 * The panel owns the two draw mutations (`useCutDraw` / `useUncutDraw`), so a test that
 * clicks one of its verbs must stub the draw endpoint itself — `mockEventCutDrawEndpoint`
 * / `mockEventUncutDrawEndpoint` (`@/mocks/endpoints/tournaments/tournaments.endpoint`).
 * Rendering alone fetches nothing: the fixtures ride the event it is handed.
 */
export const drawPanelPage = {
  render(overrides: Partial<DrawPanelProps> = {}) {
    render(<DrawPanel {...buildDrawPanelProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
