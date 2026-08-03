import { buildDrawTypes } from '../data/seed.factory'

import type { SchedulePreviewModalProps } from './schedule-preview-modal'

/** Props for `SchedulePreviewModal` — open, no-op handlers, and a single event whose
 * id matches the mock store's default synthetic field (`ev-1`), so the enqueue's
 * field summary resolves to a real name in the override control.
 *
 * `drawTypes` is the seeded catalogue (the same rows the real detail payload carries),
 * so a refused-enqueue test resolves a wire slug to the words a director actually
 * reads instead of asserting against a label typed in the test. */
export function buildSchedulePreviewModalProps(
  overrides: Partial<SchedulePreviewModalProps> = {},
): SchedulePreviewModalProps {
  return {
    open: true,
    onOpenChange: () => {},
    tournamentId: 't-1',
    events: [{ id: 'ev-1', name: 'Open Singles' }],
    drawTypes: buildDrawTypes(),
    ...overrides,
  }
}
