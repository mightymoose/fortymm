import { interactiveControlsIn, interactiveElementsIn } from '@/test/read-only'
import { render, screen, within, type Container } from '@/test/utilities'

import type { ReservationEntry } from '../../data/types'
import {
  buildReservationsSectionProps,
  type ReservationsHarnessInputs,
} from './reservations-section.factory'
import { ReservationsHarness } from './reservations-section.harness'
import { reservationCardPage } from './reservations-section/reservation-card.page'

const scoped = (container: Container) => ({
  /** Reuse the reservation-card queries (scoped to the section). Spread first: the
   * section's own sweeps below are scoped to the *section* root, and must win
   * over the card-scoped ones of the same name — a card-scoped sweep throws once
   * there is more than one reservation. */
  ...reservationCardPage.within(container),

  getAddReservationButton() {
    return container.getByRole('button', { name: /Add (first )?reservation/ })
  },
  /** Absent for a viewer: a mutating affordance is hidden, never disabled. */
  queryAddReservationButton() {
    return container.queryByRole('button', { name: /Add (first )?reservation/ })
  },
  queryReservationCards() {
    return container.queryAllByTestId('reservation-card')
  },
  /** Every reservation's name, **in the order the cards render** — the claim
   * `Reservation.position` exists to make (`inPositionOrder`, `data/helpers`), and one
   * no name-addressed accessor can state: `getReservationNameInputs()` returns boxes
   * without saying which reservation each holds.
   *
   * Reads the box when there is one and the read-back text when there is not, so the
   * editor's order and the viewer's are the same assertion. */
  getReservationNames(): string[] {
    return container.queryAllByTestId('reservation-card').map((card: HTMLElement) => {
      const box = within(card).queryByLabelText<HTMLInputElement>('Reservation name')
      return box
        ? box.value
        : (within(card).getByTestId('reservation-name').textContent ?? '').trim()
    })
  },
  /** Every reservation's name box, in card order — the card-scoped `getNameInput()`
   * throws once there is more than one reservation, and "which card is red?" is a
   * question about the whole list. */
  getReservationNameInputs() {
    return container.queryAllByLabelText('Reservation name')
  },
  /** The red messages under the name boxes, in card order (`reservationNameIssues`).
   * Empty until a save has been attempted — the editor hands the section nothing before
   * then. */
  getReservationNameErrors(): (string | null)[] {
    return container
      .queryAllByTestId('reservation-name-error')
      .map((node: HTMLElement) => node.textContent)
  },
  /** Every Remove-reservation button, in render order — to remove a specific card.
   *
   * `hidden: false` is NOT passed and must not be: a *disabled* button (the cut-draw
   * freeze, ADR-0786) is still in the accessibility tree with its name, and a query that
   * dropped it would report "no Remove button" for a state whose whole point is that the
   * button is there, visible, and dead. */
  getRemoveReservationButtons() {
    return container.queryAllByRole('button', { name: 'Remove reservation' })
  },
  /** The notice that says the group SET is frozen because the draw is cut — and how to
   * get out of it. Absent when there is no draw, and absent for a viewer (who has no
   * add/remove affordance to explain and no draw to delete). */
  queryFrozenNotice() {
    return container.queryByTestId('reservations-frozen-notice')
  },
  /** The live `reservations` array in form state (via the probe), so a test can assert
   * that an add / edit / remove flowed through `useFieldArray`.
   *
   * `ReservationEntry[]`, not `Reservation[]`: what the form holds is the **diff** the
   * save serializes (ADR 20260801) — entries that either cite the id the server minted
   * (`kind: 'kept'`) or carry none at all (`kind: 'added'`). Read off the probe's JSON,
   * so `'id' in entry` is a real question about the payload rather than about a
   * TypeScript type. */
  getReservations(): ReservationEntry[] {
    const el = container.queryByTestId('reservations-probe')
    return el ? (JSON.parse(el.textContent || '[]') as ReservationEntry[]) : []
  },
  /** The double-booking warning. Addressed by testid rather than by `role="alert"`:
   * the freeze notice is an `Alert` too, and an event can be both frozen and
   * double-booked — a role query would throw on exactly that overlap. */
  queryConflictAlert() {
    return container.queryByTestId('reservations-conflict-alert')
  },
  /** Every interactive control in the section, swept by role. Supplement only —
   * `getFormElements()` is the guarantee. */
  getInteractiveControls() {
    return interactiveControlsIn(container)
  },
  /** Every interactive element in the section, swept by DOM (`@/test/read-only`).
   * Empty is the point of the read-only view. */
  getFormElements() {
    return interactiveElementsIn(container.getByTestId('reservations-section'))
  },
})

/** Test page-object for `ReservationsSection`. */
export const reservationsSectionPage = {
  render(overrides: Partial<ReservationsHarnessInputs> = {}) {
    render(<ReservationsHarness {...buildReservationsSectionProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
