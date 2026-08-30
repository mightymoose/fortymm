import { buildReservation, buildTables } from '../../../data/seed.factory'
import type { ReservationCardProps } from './reservation-card'

/** Props for `ReservationCard` — Reservation A, first card, with four of six tables
 * selected, editable (the creator's view), and removable. Pass `canEdit: false` for a
 * viewer's read-only rendering, `removal: { kind: 'frozen', reasonId }` for a
 * reservation whose event has a cut draw (ADR-0786): the trash button dies, and
 * *nothing else does* — or `position` for a card sitting elsewhere than first, which
 * is what names its Remove control (#1441). */
export function buildReservationCardProps(
  overrides: Partial<ReservationCardProps> = {},
): ReservationCardProps {
  return {
    reservation: buildReservation(),
    tables: buildTables(6),
    timezone: 'America/Chicago',
    canEdit: true,
    position: 1,
    removal: { kind: 'allowed' },
    onChange: () => {},
    onRemove: () => {},
    ...overrides,
  }
}
