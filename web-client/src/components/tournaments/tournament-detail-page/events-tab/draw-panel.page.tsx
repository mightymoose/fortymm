import { interactiveElementsIn } from '@/test/read-only'
import { render, screen, type Container } from '@/test/utilities'

import { confirmIrreversibleActDialogPage } from '../confirm-irreversible-act-dialog.page'
import { DrawPanel, type DrawPanelProps } from './draw-panel'
import { buildDrawPanelProps } from './draw-panel.factory'
import { poolDrawPage } from './draw-panel/pool-draw.page'
import { swissRoundsPage } from './draw-panel/swiss-rounds.page'

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

  /** The **confirm** the two destructive verbs are gated by — Re-cut and Delete open it
   * and send nothing; the act is fired by its own button. Always addressed at `screen`,
   * whatever the panel's scope: the dialog portals to the document body, so it is never
   * inside the card a container narrows to. (Generate has none, by design.) */
  confirm: confirmIrreversibleActDialogPage.within(screen),

  /** The **designed empty state** of an event with no draw — inert copy, never a
   * spinner and never an error. */
  queryEmptyState() {
    return container.queryByTestId('draw-empty')
  },
  getEmptyState() {
    return container.getByTestId('draw-empty')
  },

  /** The inline **refusal** — the 409, the 422 and every other failure, in the place the
   * click happened.
   *
   * Addressed by its own testid, not by `role="alert"`. The freeze notice below is an
   * `Alert` too, and the two genuinely co-occur: a director who clicks Re-cut a moment
   * before the first score lands meets the 409 *and* then refetches into the evidence that
   * freezes the verbs. "The alert" would throw on exactly that overlap — the same lesson
   * `pools-section` wrote down one surface over. */
  queryNotice() {
    return container.queryByTestId(/^draw-notice-/)
  },
  findNotice() {
    return container.findByTestId(/^draw-notice-/)
  },
  /** The notice as one normalised string — title *and* the sentence beneath it, since
   * the whole point of the 409/422 copy is that both halves are there. */
  async findNoticeText() {
    const notice = await container.findByTestId(/^draw-notice-/)
    return (notice.textContent ?? '').replace(/\s+/g, ' ').trim()
  },

  /** The **freeze** notice — why Re-cut and Delete are dead on a draw that is under way
   * (`drawVerbFreeze`). Shown to the director alone: a reader has no verbs to explain.
   * `query…` because "a non-owner is told nothing about a freeze that is not theirs" is
   * half the claim. */
  queryFrozenNotice(eventId: string) {
    return container.queryByTestId(`draw-frozen-notice-${eventId}`)
  },
  getFrozenNotice(eventId: string) {
    return container.getByTestId(`draw-frozen-notice-${eventId}`)
  },

  /** EVERY control in the panel. The sweep a "a non-owner is offered nothing" claim
   * actually needs: the named accessors above would miss a button that was renamed or
   * left unlabelled, and "no *enabled* button" is not the assertion — "no button at
   * all" is (ADR-0015: hide the affordance, never disable it). */
  getPanelControls(eventId: string) {
    return interactiveElementsIn(container.getByTestId(`draw-panel-${eventId}`))
  },

  /** The un-pooled group **as a bracket** — a single-elim draw, or the knockout stage of an
   * `rr-then-ko` one. `query…` because "this draw did NOT get the bracket" is half of the
   * routing claim. */
  queryUnpooled() {
    return container.queryByTestId('draw-unpooled')
  },

  /** The un-pooled group **as swiss rounds**. The other half of the same claim: a swiss draw
   * is un-pooled exactly as a bracket is, so the two hooks are what tell "routed on the draw
   * type" from "routed on the null pool id" (`unpooledShape`, `../../data/draw`). */
  querySwissRounds() {
    return container.queryByTestId('draw-swiss-rounds')
  },
  getSwissRounds() {
    return container.getByTestId('draw-swiss-rounds')
  },

  /** The un-pooled group as **nothing in particular** — the plain list a fixture gets when
   * the event's format has no view that can place it (a round-robin fixture naming a pool
   * the event does not list). The third hook of the same routing claim: it is what says the
   * fixture was shown *without* being called a bracket. */
  queryOrphaned() {
    return container.queryByTestId('draw-orphaned')
  },
  getOrphaned() {
    return container.getByTestId('draw-orphaned')
  },

  // Pools, rounds and fixture lines come from the child page objects; the swiss rounds'
  // own accessors (a paired round's lines, a forthcoming round's copy) from theirs.
  ...poolDrawPage.within(container),
  swiss: swissRoundsPage.within(container),
})

/**
 * Test page-object for `DrawPanel`.
 *
 * The panel owns the two draw mutations (`useCutDraw` / `useUncutDraw`), so a test that
 * clicks one of its verbs must stub the draw endpoint itself — `mockEventCutDrawEndpoint`
 * / `mockEventUncutDrawEndpoint` (`@/mocks/endpoints/tournaments/tournaments.endpoint`).
 * Rendering alone fetches nothing: the fixtures ride the event it is handed.
 *
 * A test driving **Re-cut** or **Delete** must go through `confirm` — clicking the verb
 * alone opens the dialog and sends nothing, which is the whole point of it. **Generate**
 * is the exception: the first cut fires on its single click.
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
