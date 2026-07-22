import type { SchedulePreviewModalProps } from './schedule-preview-modal'

/** Props for `SchedulePreviewModal` — open, no-op handlers, and a single event whose
 * id matches the mock store's default synthetic field (`ev-1`), so the enqueue's
 * field summary resolves to a real name in the override control. */
export function buildSchedulePreviewModalProps(
  overrides: Partial<SchedulePreviewModalProps> = {},
): SchedulePreviewModalProps {
  return {
    open: true,
    onOpenChange: () => {},
    tournamentId: 't-1',
    events: [{ id: 'ev-1', name: 'Open Singles' }],
    ...overrides,
  }
}
