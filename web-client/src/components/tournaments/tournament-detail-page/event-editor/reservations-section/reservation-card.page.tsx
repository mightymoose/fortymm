import { interactiveControlsIn, interactiveElementsIn } from '@/test/read-only'
import { render, screen, type Container } from '@/test/utilities'

import { fieldPage } from '../../../field.page'
import { ReservationCard, type ReservationCardProps } from './reservation-card'
import { buildReservationCardProps } from './reservation-card.factory'

const scoped = (container: Container) => ({
  /** Reuse the `Field` row queries — the reservation's window is three `Field` rows,
   * whose read-only values `getFieldValue(label)` reads back. */
  ...fieldPage.within(container),

  getCard() {
    return container.getByTestId('reservation-card')
  },
  getNameInput() {
    return container.getByLabelText('Reservation name')
  },
  queryNameInput() {
    return container.queryByLabelText('Reservation name')
  },
  /** The red message under the name box — the resolver's verdict on this
   * reservation's name (`reservationNameSchema`). Absent until a save is actually
   * attempted, and absent for a viewer, who has no box to clear. */
  queryNameError() {
    return container.queryByTestId('reservation-name-error')
  },
  /** The red message under the reservation's window — #1501's ordering/containment
   * verdict (`reservationWindowIssues`, `event-form.ts`). Absent until a save is
   * actually attempted, and absent for a viewer. */
  queryWindowError() {
    return container.queryByTestId('reservation-window-error')
  },
  getDateInput() {
    return container.getByLabelText('Date')
  },
  getStartInput() {
    return container.getByLabelText('Start')
  },
  getEndInput() {
    return container.getByLabelText('End')
  },
  getTableToggle(label: string) {
    return container.getByRole('button', { name: label, pressed: false })
  },
  getSelectedTableToggle(label: string) {
    return container.getByRole('button', { name: label, pressed: true })
  },
  getRemoveButton() {
    return container.getByRole('button', { name: 'Remove reservation' })
  },
  /** Absent for a viewer: a mutating affordance is hidden, never disabled. */
  queryRemoveButton() {
    return container.queryByRole('button', { name: 'Remove reservation' })
  },
  /** The reservation's name, read back as text (the read-only counterpart of the name
   * box). */
  getName() {
    return container.getByTestId('reservation-name')
  },
  /** The tables this reservation reserves, read back as a list. */
  getReservedTables() {
    return container.getByTestId('reservation-tables')
  },
  /** The timezone caption beside this reservation's window
   * (`reservation-timezone-label`) — the frame its wall-clock times are in (ADR
   * 20260719), shown to editor and reader alike. Not interactive, so it never touches
   * the read-only guard sweep. */
  getTimezoneLabel() {
    return container.getByTestId('reservation-timezone-label')
  },
  /** Every interactive control in the card, swept by role. Supplement only —
   * `getFormElements()` is the guarantee. */
  getInteractiveControls() {
    return interactiveControlsIn(container)
  },
  /** Every interactive element in the card, swept by DOM (`@/test/read-only`).
   * Empty is the point of the read-only view. */
  getFormElements() {
    return interactiveElementsIn(container.getByTestId('reservation-card'))
  },
})

/** Test page-object for `ReservationCard`. */
export const reservationCardPage = {
  render(overrides: Partial<ReservationCardProps> = {}) {
    render(<ReservationCard {...buildReservationCardProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
